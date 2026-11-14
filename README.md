# WeatherWise — ECMWF Open Data + ECDS/MARS

## Τι περιλαμβάνει
- Τα προγνωστικά πεδία ECMWF IFS χαρτών λαμβάνονται απευθείας από το ECMWF Open Data σε GRIB2.
- Ο server αποκωδικοποιεί τα GRIB με ecCodes και επιστρέφει τιμές στα σημεία του χάρτη.
- Το `/api/ecmwf` δέχεται συντεταγμένες, μεταβλητές και forecast lead (`step`).
- Η λήψη GRIB αποθηκεύεται προσωρινά στον server ώστε να αποφεύγονται επαναλαμβανόμενες λήψεις.
- Το `/api/ecds/status` ελέγχει αν έχουν ρυθμιστεί τα διαπιστευτήρια ECDS.
- Υπάρχει admin-side helper `ecds_archive_client.py` για αρχειακά datasets μέσω CDS API. Δεν εκτίθεται ως δημόσιο endpoint.

## ECMWF Open Data
Το Open Data είναι δημόσιο και δεν χρειάζεται API key. Το πακέτο χρησιμοποιεί το επίσημο `ecmwf-opendata` Python client και ecCodes. Τα επιχειρησιακά IFS δεδομένα είναι GRIB2. Οι διαθέσιμοι χρόνοι πρόγνωσης εξαρτώνται από τον κύκλο:
- 00/12 UTC: 0–144h ανά 3h και 150–360h ανά 6h.
- 06/18 UTC: 0–90h ανά 3h.

Το UI του WeatherWise έχει χρονικό ορίζοντα έως 240h. Η διαθεσιμότητα συγκεκριμένου lead εξαρτάται από τον τελευταίο διαθέσιμο κύκλο ECMWF.

## ECDS / MARS αρχειακά δεδομένα
Στο Render → Environment πρόσθεσε:
- `CDSAPI_URL` = `https://ecds.ecmwf.int/api`
- `CDSAPI_KEY` = το προσωπικό API token που εμφανίζει ο λογαριασμός σου στο ECDS.

Μην βάλεις το token στο `index.html`, στο GitHub ή σε δημόσιο αρχείο. Το `/api/ecds/status` επιβεβαιώνει μόνο ότι οι μεταβλητές έχουν οριστεί· δεν εγγυάται πρόσβαση σε κάθε dataset. Πρέπει πρώτα να αποδεχθείς χειροκίνητα τους Terms of Use στη σελίδα κάθε dataset. Τα διαθέσιμα datasets, τα πεδία και τα χρονικά βήματα διαφέρουν ανά dataset.

Το `ecds_archive_client.py` είναι εργαλείο server-side για ενσωμάτωση σε ελεγχόμενη εργασία διαχείρισης. Για κάθε dataset πρέπει να δημιουργηθεί συγκεκριμένο, ελεγμένο request από το κουμπί “Show API request code” της σελίδας του dataset. Δεν υπάρχει γενικό MARS endpoint που να μπορεί να υποθέσει με ασφάλεια όλα τα ονόματα datasets/πεδίων.

## Deploy στο Render
1. Αντικατάστησε τα αρχεία του repository με τα περιεχόμενα αυτού του ZIP.
2. Το Render θα κάνει deploy μέσω του `Dockerfile` (Node + Python + ecCodes).
3. Στο Render → Environment πρόσθεσε τα `CDSAPI_URL` και `CDSAPI_KEY`.
4. Κάνε Manual Deploy → Clear build cache & deploy.
5. Έλεγξε:
   - `/health`
   - `/api/ecds/status`
   - `/api/ecmwf?latitude=37.98&longitude=23.72&hourly=temperature_2m&step=24`

## Σημαντική διάκριση πηγών
- Οι προγνωστικοί χάρτες ECMWF IFS χρησιμοποιούν απευθείας ECMWF Open Data.
- Η επιλογή NOAA GFS παραμένει ξεχωριστή.
- Τα υπάρχοντα τμήματα τρέχουσας κατάστασης/παρατηρήσεων και ορισμένες συγκρίσεις πόλεων εξακολουθούν να χρησιμοποιούν Open-Meteo. Δεν παρουσιάζονται ως δεδομένα ECMWF, επειδή η πρόγνωση μοντέλου δεν είναι ισοδύναμη με πραγματική παρατήρηση σταθμού.
- Οι χάρτες καιρού δεν αποτελούν επίσημη υπηρεσία προειδοποιήσεων.

## Άδειες και attribution
Τα ECMWF Open Data διατίθενται με CC-BY-4.0 και τους όρους χρήσης ECMWF. Να διατηρείται η αναφορά πηγής ECMWF στην εφαρμογή.
