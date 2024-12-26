// app.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const app = express();

// Middleware untuk parsing JSON
app.use(express.json());

// Konfigurasi Database
const dbPath = path.resolve(__dirname, 'weight_sensor.db');
const db = new sqlite3.Database(dbPath);

// Konfigurasi VPS
const VPS_URL = 'http://your-vps-ip:port/api/weight-data'; // Ganti dengan URL VPS Anda

// Inisialisasi Database
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS weight_measurements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            weight REAL NOT NULL,
            status TEXT NOT NULL,
            is_anomaly BOOLEAN DEFAULT 0,
            is_sent_to_vps BOOLEAN DEFAULT 0,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// Function untuk mengirim data ke VPS
const sendToVPS = async (data) => {
    try {
        const response = await axios.post(VPS_URL, data);
        return response.status === 200;
    } catch (error) {
        console.error('Error sending to VPS:', error.message);
        return false;
    }
};

// Function untuk mencoba mengirim ulang data yang belum terkirim
const retrySendingFailedData = async () => {
    db.all(`
        SELECT id, weight, status, timestamp 
        FROM weight_measurements 
        WHERE is_sent_to_vps = 0 AND is_anomaly = 0
        ORDER BY timestamp ASC
    `, async (err, rows) => {
        if (err) {
            console.error('Error getting unsent data:', err);
            return;
        }

        for (const row of rows) {
            const success = await sendToVPS({
                weight: row.weight,
                status: row.status,
                timestamp: row.timestamp
            });

            if (success) {
                db.run(`
                    UPDATE weight_measurements 
                    SET is_sent_to_vps = 1 
                    WHERE id = ?
                `, [row.id]);
            }
        }
    });
};

// Function untuk mendapatkan data terakhir yang valid
const getLastValidMeasurement = () => {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT weight, status, timestamp 
            FROM weight_measurements 
            WHERE is_anomaly = 0 
            ORDER BY timestamp DESC 
            LIMIT 1
        `, (err, row) => {
            if (err) reject(err);
            resolve(row);
        });
    });
};

// Route untuk menerima data dari ESP8266
app.post('/api/data', async (req, res) => {
    try {
        const { weight, status } = req.body;
        const weightValue = parseFloat(weight);
        
        // Check untuk anomali (weight > 5kg)
        const is_anomaly = weightValue > 5000; // assuming weight in grams

        // Simpan data ke database
        db.run(`
            INSERT INTO weight_measurements (weight, status, is_anomaly)
            VALUES (?, ?, ?)
        `, [weightValue, status, is_anomaly ? 1 : 0], async function(err) {
            if (err) {
                throw err;
            }

            // Jika data normal, kirim ke VPS
            if (!is_anomaly) {
                const success = await sendToVPS({
                    weight: weightValue,
                    status: status,
                    timestamp: new Date().toISOString()
                });

                if (success) {
                    db.run(`
                        UPDATE weight_measurements 
                        SET is_sent_to_vps = 1 
                        WHERE id = ?
                    `, [this.lastID]);
                }
            } else {
                // Jika anomali, coba kirim data terakhir yang valid
                const lastValid = await getLastValidMeasurement();
                if (lastValid) {
                    await sendToVPS({
                        weight: lastValid.weight,
                        status: lastValid.status,
                        timestamp: lastValid.timestamp
                    });
                }
            }
        });

        // Response ke ESP8266
        if (is_anomaly) {
            const lastValid = await getLastValidMeasurement();
            if (lastValid) {
                return res.json({
                    weight: lastValid.weight,
                    status: lastValid.status,
                    timestamp: lastValid.timestamp,
                    message: 'Anomaly detected, returned last valid measurement'
                });
            }
            return res.json({
                message: 'Anomaly detected, no valid previous measurement found'
            });
        }

        return res.json({
            message: 'Data received successfully',
            weight: weightValue,
            status: status
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Coba kirim ulang data yang gagal setiap 5 menit
setInterval(retrySendingFailedData, 5 * 60 * 1000);

const PORT = process.env.PORT || 83;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// Handle program termination
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Database connection closed');
        process.exit(0);
    });
});