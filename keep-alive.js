// keep-alive.js
// Acelasi model ca stremio-regielive/keep-alive.js (deja dovedit in productie
// acolo): la fiecare 14 minute, serviciul se autoping-uieste pe URL-ul lui
// public, ca sa nu-l lase Render sa adoarma dupa 15 minute de inactivitate.
//
// Diferenta fata de varianta RegieLive: in loc de URL hardcodat, folosim
// RENDER_EXTERNAL_URL — variabila pe care Render o seteaza automat pentru
// orice Web Service — ca sa nu trebuiasca actualizat manual fisierul dupa
// fiecare redeploy sau schimbare de nume a serviciului.

const https = require('https');

const SELF_URL = `${process.env.RENDER_EXTERNAL_URL}/manifest.json`;

console.log('[Anti-Sleep] Serviciul de mentinere activa a pornit.');

setInterval(() => {
    https.get(SELF_URL, (res) => {
        console.log(`[Anti-Sleep] Ping trimis cu succes catre ${SELF_URL}. Status: ${res.statusCode}`);
    }).on('error', (err) => {
        console.error(`[Anti-Sleep] Eroare la ping: ${err.message}`);
    });
}, 840000); // 14 minute in milisecunde
