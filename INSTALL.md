# Ghid de instalare — Mega Subtitle Addon

Acest ghid te duce de la zero (un fork pe GitHub) până la un addon Stremio/Nuvio complet funcțional, găzduit gratuit pe Render, cu toate cele 4 surse de subtitrări active: RegieLive, Titrari.ro, Subtitrari-noi.ro, Subs.ro.

Poți urma pașii singur, sau poți da acest fișier unui asistent AI și îi ceri să te ghideze pas cu pas — fiecare pas de mai jos e scris să fie suficient de precis pentru amândouă variantele.

## Ce cont ai nevoie, înainte de a începe

- **GitHub** — ca să faci fork la repo.
- **Render** ([render.com](https://render.com)) — gratuit, aici rulează addon-ul.
- **Upstash** ([upstash.com](https://upstash.com)) — gratuit, aici stă cache-ul (căutări + subtitrări deja descărcate).
- **Subs.ro** — cont pe site, pentru cheia lor de API.
- **Titrari.ro** — cont pe site, pentru sesiunea de login.

---

## Pasul 1 — Fork la repo pe GitHub

1. Deschide pagina repo-ului original pe GitHub.
2. Apasă butonul **Fork** (dreapta sus).
3. Alege propriul cont GitHub ca destinație.

Acum ai propria ta copie independentă a codului.

---

## Pasul 2 — Creezi baza de date Redis pe Upstash

Redis-ul ține cache-ul (căutări recente + subtitrări deja descărcate), ca să nu se reia munca la fiecare cerere.

1. Intri pe [console.upstash.com](https://console.upstash.com), te loghezi/înregistrezi.
2. **Create Database**.
3. Alegi un nume (orice), regiunea **Frankfurt** (cea mai apropiată de România — aceeași regiune pe care o vei alege și la Render).
4. Plan: **Free**.
5. Odată creată, intri pe pagina bazei de date → secțiunea **REST API** → copiezi:
   - `UPSTASH_REDIS_REST_URL` (arată ca `https://ceva.upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN` (un șir lung de caractere)
6. Pentru token, dacă apare ascuns (`********`), apeși iconița cu ochi ca să-l dezvălui, apoi **iconița de copiere** dedicată (nu selectezi manual textul — riști să copiezi și un spațiu/rând gol în plus, care strică autentificarea).

Păstrează cele două valori undeva, le pui la Pasul 6.

---

## Pasul 3 — Cheia API de la Subs.ro

Contactează Subs.ro (prin contul tău de pe site, sau canalul lor de contact) și cere acces API. Nu am un proces exact documentat aici — depinde de ce îți oferă ei la momentul respectiv.

Odată primită, o notezi — merge la `SUBSRO_API_KEY`, Pasul 6.

Dacă nu ai încă cheia, poți sări acest pas — addon-ul pornește și fără ea, doar sursa Subs.ro rămâne dezactivată până o adaugi.

---

## Pasul 4 — Cookie-ul de sesiune de la Titrari.ro

Căutarea pe Titrari.ro e complet publică — addon-ul vede și afișează rezultatele lor fără nicio autentificare, la fel ca un vizitator obișnuit. Cookie-ul e nevoie doar la pasul următor, **descărcarea** efectivă a unei subtitrări alese, pas pe care Titrari.ro îl condiționează de un cont logat.

1. Te loghezi normal, într-un browser, cu **propriul tău cont** de pe titrari.ro (nu împrumuta contul altcuiva).
2. Deschizi DevTools (F12) → **Application** (Chrome) sau **Storage** (Firefox) → **Cookies** → cauți `PHPSESSID` pentru titrari.ro.
3. Copiezi doar **valoarea** (coloana Value), nu tot rândul și nu numele `PHPSESSID`.

Valoarea arată ca un șir aleator de litere/cifre (fără `PHPSESSID=` în față, fără spații) — merge la `TITRARI_COOKIE`, Pasul 6.

**Atenție:** sesiunea asta poate expira după o vreme de inactivitate. Cum căutarea rămâne publică indiferent de cookie, subtitrările de pe Titrari tot vor *apărea* în listă chiar și cu sesiunea expirată — semnul real că a expirat e că alegerea uneia dintre ele la descărcare eșuează sau vine goală. Dacă vezi asta, cel mai probabil trebuie refăcut acest pas: te re-loghezi pe titrari.ro și iei un `PHPSESSID` nou.

---

## Pasul 5 — Deploy pe Render (Blueprint)

Fork-ul tău conține deja `render.yaml` — Render citește singur din el toate setările de mai jos, nu le mai completezi manual.

1. Intri pe [dashboard.render.com](https://dashboard.render.com), te loghezi/înregistrezi.
2. **New** → **Blueprint**.
3. Conectezi contul de GitHub și alegi fork-ul tău al repo-ului.
4. Render găsește `render.yaml` și îți arată un serviciu gata completat:

| Câmp | Valoare |
|---|---|
| Branch | `main` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Instance Type | Free |
| Region | Frankfurt |
| Auto-Deploy | Yes, la fiecare commit |
| Health Check Path | `/manifest.json` |

Nu apeși încă pe butonul final — mai întâi variabilele de mediu, la pasul următor (îți sunt cerute pe același ecran, imediat sub tabelul de mai sus).

---

## Pasul 6 — Variabile de mediu

Pe același ecran, Render îți cere valorile pentru variabilele care nu au valoare implicită în cod:

| Variabilă | Valoare | Obligatorie? |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | de la Pasul 2 | Da |
| `UPSTASH_REDIS_REST_TOKEN` | de la Pasul 2 | Da |
| `SUBSRO_API_KEY` | de la Pasul 3 | Nu — lași gol, doar sursa Subs.ro rămâne dezactivată |
| `TITRARI_COOKIE` | de la Pasul 4 | Nu — lași gol, doar sursa Titrari rămâne dezactivată |
| `REGIELIVE_API_KEY` | cheia ta personală de la RegieLive, dacă ai solicitat și primit una | Nu — lași gol, se folosește cheia comună, împărțită cu toate fork-urile |

`ADMIN_KEY` nu mai apare în listă — `render.yaml` îi spune lui Render s-o genereze singur, unică pentru serviciul tău, fără să faci nimic. O vezi oricând în Render → serviciul tău → **Environment** → `ADMIN_KEY` (butonul de afișare). Codul nu mai are o cheie implicită: dacă variabila lipsește (de ex. serviciu creat manual, nu din Blueprint), rutele `/admin/...` sunt pur și simplu dezactivate — o adaugi manual în Environment cu orice valoare lungă, aleatorie.

Nu trebuie să adaugi `PORT` sau `RENDER_EXTERNAL_URL` — Render le dă automat, codul le folosește singur.

Apeși **Apply** (sau **Deploy Blueprint**) ca să creezi serviciul.

Dacă preferi fluxul clasic (**New** → **Web Service**, completat manual câmp cu câmp), merge la fel — `render.yaml` e doar un mod mai rapid de a ajunge la aceleași setări, nu o cerință.

---

## Pasul 7 — Verifici că funcționează

1. Aștepți să apară `Your service is live` în tab-ul **Logs**.
2. Deschizi în browser `https://<numele-serviciului-tau>.onrender.com/manifest.json` — ar trebui să vezi un răspuns JSON.
3. În Logs, ar trebui să vezi (fără erori):
   - `[CACHE-REDIS] Initializat (Upstash Redis).`
   - `[CACHE] Backend activ: Redis (Upstash)`
   - `[Anti-Sleep] Serviciul de mentinere activa a pornit.`

---

## Pasul 8 — Instalezi în Stremio sau Nuvio

1. Copiezi URL-ul: `https://<numele-serviciului-tau>.onrender.com/manifest.json`
2. În Stremio: **Addons** → lipești URL-ul în câmpul de instalare din partea de sus → **Install**.
3. În Nuvio: secțiunea de addon-uri/subtitrări → adaugi același URL.

---

## De știut, pe termen lung

- **Prima accesare după o perioadă de inactivitate poate dura ~1 minut** — Render adoarme serviciile gratuite neaccesate 15 minute; addon-ul se auto-ping-uiește la fiecare 14 minute ca să rămână treaz, dar tot poate exista un cold-start ocazional.
- **Cheia RegieLive e comună, dacă nu pui una proprie** — implicit, orice fork folosește aceeași cheie (`API-BAZARR-YTZ-SL`), deci mai multe fork-uri cu trafic mare pot să se limiteze reciproc la RegieLive. Dacă la un moment dat soliciți și primești o cheie personală de la RegieLive, o adaugi ca variabilă de mediu `REGIELIVE_API_KEY` (Pasul 6) — nu trebuie să editezi cod, doar adaugi variabila, exact ca la celelalte.
- **Cota gratuită Render**: 750 ore/lună per cont — un singur serviciu rulat non-stop încape confortabil (~744h/lună în cea mai lungă lună).
