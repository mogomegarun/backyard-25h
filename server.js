const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('.'));

const db = new sqlite3.Database('./backyard.db');

// Initialisation de la Base de Données
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strava_id INTEGER UNIQUE,
    firstname TEXT,
    lastname TEXT,
    refresh_token TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS laps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    lap_number INTEGER,
    distance_m REAL,
    duration_sec INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

// 1. Authentification Strava OAuth
app.get('/api/auth/strava', (req, res) => {
  const redirectUri = `${process.env.APP_URL}/api/auth/strava/callback`;
  const url = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=force&scope=activity:read_all`;
  res.redirect(url);
});

app.get('/api/auth/strava/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code'
    });

    const { athlete, refresh_token } = tokenRes.data;

    db.run(
      `INSERT INTO users (strava_id, firstname, lastname, refresh_token)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(strava_id) DO UPDATE SET refresh_token = ?`,
      [athlete.id, athlete.firstname, athlete.lastname, refresh_token, refresh_token]
    );

    res.redirect('/?status=success');
  } catch (err) {
    res.status(500).send("Erreur lors de l'authentification Strava.");
  }
});

// 2. Webhook Strava (Réception automatique des courses)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
    return res.json({ "hub.challenge": challenge });
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  const { object_type, aspect_type, object_id, owner_id } = req.body;

  if (object_type === 'activity' && aspect_type === 'create') {
    processActivity(owner_id, object_id);
  }
});

// 3. Algorithme de découpe et de validation des boucles (6 706m / 60 min)
async function processActivity(stravaAthleteId, activityId) {
  db.get(`SELECT * FROM users WHERE strava_id = ?`, [stravaAthleteId], async (err, user) => {
    if (!user) return;

    try {
      // Obtenir un nouvel Access Token
      const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: user.refresh_token
      });

      const accessToken = tokenRes.data.access_token;

      // Récupérer les détails de la course
      const actRes = await axios.get(`https://www.strava.com/api/v3/activities/${activityId}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const activity = actRes.data;
      const targetDistance = 6650; // 6706m avec marge de tolérance GPS
      
      // Découpe par tranche de 60 minutes
      const totalHours = Math.floor(activity.elapsed_time / 3600);
      const totalDistance = activity.distance;

      db.get(`SELECT COUNT(*) as count FROM laps WHERE user_id = ?`, [user.id], (err, row) => {
        let currentLap = row.count + 1;

        if (totalHours <= 1 && totalDistance >= targetDistance) {
          // Cas 1 : Une seule boucle enregistrée
          db.run(`INSERT INTO laps (user_id, lap_number, distance_m, duration_sec) VALUES (?, ?, ?, ?)`,
            [user.id, currentLap, activity.distance, activity.moving_time]);
        } else if (totalHours > 1) {
          // Cas 2 : Activité unique continue de plusieurs heures
          const averageDistancePerLap = totalDistance / totalHours;
          if (averageDistancePerLap >= targetDistance) {
            for (let i = 0; i < totalHours; i++) {
              db.run(`INSERT INTO laps (user_id, lap_number, distance_m, duration_sec) VALUES (?, ?, ?, ?)`,
                [user.id, currentLap + i, averageDistancePerLap, 3600]);
            }
          }
        }
      });

    } catch (err) {
      console.error("Erreur de traitement de l'activité Strava :", err.message);
    }
  });
}

// 4. API Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const query = `
    SELECT u.firstname || ' ' || SUBSTR(u.lastname, 1, 1) || '.' as name,
           COUNT(l.id) as laps,
           SUM(l.duration_sec) as total_seconds
    FROM users u
    JOIN laps l ON u.id = l.user_id
    GROUP BY u.id
    ORDER BY laps DESC, total_seconds ASC
  `;

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json([]);
    
    const formatted = rows.map(r => {
      const hrs = Math.floor(r.total_seconds / 3600);
      const mins = Math.floor((r.total_seconds % 3600) / 60);
      return {
        name: r.name,
        laps: r.laps,
        total_time: `${hrs}h ${mins}m`
      };
    });
    
    res.json(formatted);
  });
});

app.listen(3000, () => console.log('Serveur Backyard actif sur http://localhost:3000'));
