# Sagarmatha Diagnostic and Health Care Center

Folder structure (language wise):

    sagarmatha/
    ├── index.html        <- HTML  (page structure)
    ├── css/
    │   └── style.css     <- CSS   (all styling, dark mode, animations, print)
    └── js/
        ├── config.js     <- JS    (Supabase URL + anon key - edit this)
        └── app.js        <- JS    (login, reports, bills, referred, sync logic)

## Run
Open `index.html` in a browser (or host the folder on any static host).

## Cloud sync
Edit `js/config.js` and paste your Supabase URL and anon key.
Without it, data is saved only in the browser (localStorage).
Default offline login: admin / sagarmatha123 (change it in the Account tab).

Note: config.js must load before app.js (already set in index.html).
