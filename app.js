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

// Konfigurasi URL VPS
const VPS_URL = 'http://your-vps-ip:port/api/data'; // Ganti dengan URL VPS Anda

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
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            targetWeight REAL DEFAULT 5000
        )
    `);

    // Insert default targetWeight jika belum ada
    db.get(`SELECT COUNT(*) AS count FROM settings`, (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO settings (targetWeight) VALUES (5000)`);
        }
    });
});

// Function untuk mendapatkan targetWeight
const getTargetWeight = () => {
    return new Promise((resolve, reject) => {
        db.get(`SELECT targetWeight FROM settings LIMIT 1`, (err, row) => {
            if (err) reject(err);
            resolve(row.targetWeight);
        });
    });
};

// Function untuk mengatur targetWeight
const setTargetWeight = (newWeight) => {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE settings SET targetWeight = ?`, [newWeight], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

// Function untuk mengirim data ke VPS
const sendToVPS = async (data) => {
    try {
        console.log('Sending data to VPS:', data); // Debugging log
        const response = await axios.post(VPS_URL, data);
        console.log('Response from VPS:', response.data); // Debugging log
        return response.status === 200;
    } catch (error) {
        console.error('Error sending to VPS:', error.message);
        return false;
    }
};

// Route untuk menerima data dari sensor (misalnya ESP8266)
app.post('/api/data', async (req, res) => {
    try {
        const { weight, status } = req.body;

        if (!weight || !status || isNaN(parseFloat(weight))) {
            return res.status(400).json({ message: 'Invalid data received' });
        }

        const weightValue = parseFloat(weight);
        const targetWeight = await getTargetWeight();

        // Check untuk anomali (weight > targetWeight)
        const is_anomaly = weightValue > targetWeight;

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
                    targetWeight: targetWeight,
                    timestamp: new Date().toISOString()
                });

                if (success) {
                    db.run(`UPDATE weight_measurements SET is_sent_to_vps = 1 WHERE id = ?`, [this.lastID]);
                }
            }
        });

        return res.json({
            message: 'Data received successfully',
            weight: weightValue,
            targetWeight: targetWeight,
            status: status,
            is_anomaly: is_anomaly
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route untuk mengatur targetWeight
app.post('/api/targetWeight', async (req, res) => {
    try {
        const { targetWeight } = req.body;

        if (!targetWeight || isNaN(parseFloat(targetWeight))) {
            return res.status(400).json({ message: 'Invalid target weight' });
        }

        await setTargetWeight(parseFloat(targetWeight));
        return res.json({ message: 'Target weight updated successfully' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Jalankan server
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
