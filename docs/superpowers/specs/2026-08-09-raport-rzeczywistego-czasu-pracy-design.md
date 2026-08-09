# Raport rzeczywistego czasu pracy (plan vs. odbicia)

Data: 2026-08-09

## Problem

Przyciski „Start pracy" / „Koniec pracy" zapisują odbicia do kolumn
`schedule_entries.work_started_at` i `work_ended_at` (endpointy w `routes/api.js:652-739`).
Dane te są widoczne wyłącznie na dashboardzie, we własnych zmianach pracownika z dziś
i trzech ostatnich dni (`views/partials/_shiftRow.ejs`, zapytanie w `routes/auth.js:48`).

Oba istniejące raporty (`routes/reports.js`) liczą godziny **planowane** z zatwierdzonego
grafiku (`COALESCE(se.custom_start, st.start_time)`, `WHERE s.status='approved'`).
Nie ma żadnego widoku porównującego plan z rzeczywistością ani podsumowania odbić.

## Cel

Nowy raport kontrolny dla kierownika i admina: miesiąc × jeden pracownik, dzień po dniu
plan / faktycznie / różnica, z możliwością zbiorczego przepisania odbić do Karty czasu
pracy (dokumentu do podpisu, `/reports/employee/:userId/:month`).

Karta czasu pracy pozostaje bez zmian — dokument do podpisu i narzędzie kontrolne to dwa
osobne artefakty.

## Zakres

### Warstwa danych

`buildEmployeeReport()` (`routes/reports.js:143`) rozbić na dwie warstwy:

- `loadMonthEntries(userId, month)` — istniejące zapytanie plus `se.work_started_at,
  se.work_ended_at`. Filtr `s.status='approved'` bez zmian.
- `buildEmployeeReport()` — jak dziś, na bazie `loadMonthEntries`, bez zmian w wyniku.
- `buildActualReport()` — nowy builder, na tej samej bazie.

Dzięki wspólnemu źródłu oba raporty nie mogą się rozjechać co do zakresu dni.

### Obliczenia (`utils/workTime.js`, funkcje czyste)

Na każdy dzień z grafiku:

| Pole | Źródło |
|---|---|
| `plannedStart` / `plannedEnd` | `COALESCE(se.custom_start, st.start_time)` / `..._end` |
| `plannedHours` | `calcHours(plannedStart, plannedEnd)` — istniejący helper |
| `actualStart` / `actualEnd` | `work_started_at` / `work_ended_at` (DATETIME) |
| `actualHours` | różnica dwóch `DATETIME`, nie `calcHours(HH:MM)` — koniec zmiany nocnej ma datę następnego dnia |
| `diff` | `actualHours - plannedHours`, liczone **tylko** gdy oba odbicia istnieją; w pozostałych przypadkach `null` |

Parsowanie: `new Date(str.replace(' ', 'T'))` na naiwnym stringu lokalnym; różnica
dwóch takich dat jest niezależna od strefy.

Status dnia:

- `zgodne` — oba odbicia, `|diff| < 15 min`
- `roznica` — oba odbicia, `|diff| >= 15 min` (na plus lub minus)
- `do_sprawdzenia` — brak obu odbić **albo** start bez końca; etykieta w UI:
  „do sprawdzenia — niezgodne z grafikiem"
- `brak_zmiany` — dzień bez wpisu w grafiku (np. wolne). Nie wchodzi do żadnego licznika
  ani sumy, nie ma checkboxa.

Próg 15 minut jest stały (nie konfigurowalny) — drobne różnice przy klikaniu są normalne.

Podsumowanie miesiąca:

- `totalPlanned` — suma planu ze **wszystkich** dni z grafiku (identyczna z Kartą)
- `totalActual` — suma `actualHours` z dni z pełnym odbiciem
- `totalDiff` — **suma różnic dziennych** z dni z pełnym odbiciem

  Nie wolno liczyć jej jako `totalActual - totalPlanned`: dni bez odbicia wchodzą do
  drugiej sumy a nie do pierwszej, co dałoby fałszywy minus rzędu kilkudziesięciu godzin.
- `matchedDays` / `scheduledDays` — do podpisu „(z N z M dni)" pod różnicą
- `toCheckDays` — licznik dni ze statusem `do_sprawdzenia`

### Trasy (`routes/reports.js`)

Uprawnienia jak `/reports/employee`: `requireRole('admin', 'location_manager')`, bez
`requireFeature('reports')` (tego strażnika ma tylko `GET /reports`).

Lista pracowników do selektora — to samo zapytanie co w raporcie godzin: `active=1`,
`role IN ('worker','location_manager')`, `location_id = getLocationId(req)`.

- `GET /reports/actual` — przekierowanie na pierwszego pracownika lokalizacji i bieżący
  miesiąc. Gdy lokalizacja nie ma aktywnych pracowników: `error.ejs` z komunikatem.
- `GET /reports/actual/:userId/:month` — widok raportu.
- `GET /reports/actual/:userId/:month/csv` — eksport; kolumny: Data, Dzień, Zmiana,
  Plan od, Plan do, Plan godz., Faktycznie od, Faktycznie do, Faktycznie godz., Różnica,
  Status. Separator `;`, BOM, przecinek dziesiętny — jak istniejący eksport
  (`routes/reports.js:247`).

### Widok `views/reports/actual-hours.ejs`

- Selektory pracownika i miesiąca — te same co w `employee-hours.ejs`.
- Przycisk przełączający **Karta czasu pracy ⇄ Odbicia**, zachowujący `userId` i miesiąc;
  bliźniaczy przycisk dodać w toolbarze `employee-hours.ejs`.
- Nowa pozycja w nawigacji: „Rzeczywisty czas pracy" — w obu blokach
  (`views/partials/nav.ejs:129` i `:172`), aktywna dla `p.startsWith('/reports/actual')`.
- Tabela: `☑ | Data | Dzień | Zmiana | Plan od–do | Plan godz. | Faktycznie od–do |
  Faktycznie godz. | Różnica | Status`.
- Kolory wierszy: `do_sprawdzenia` — żółty, `roznica` — pomarańczowy, `zgodne` — bez
  wyróżnienia. Dni bez wpisu w grafiku renderowane jak w Karcie (wiersz pusty, `empty-row`).
- Checkbox aktywny wyłącznie przy dniach z pełnym odbiciem; **domyślnie zaznaczony gdy
  `diff !== 0`**, także przy statusie `zgodne` (przepisanie doprecyzowuje grafik co do
  minuty). Dni z `diff === 0` mają checkbox odznaczony — przepisanie identycznych godzin
  niczego nie zmienia.
- Pasek na dole: „Zaznaczono N dni → **Przepisz do Karty czasu pracy**", z `confirm()`
  przed wysłaniem. Pasek i checkboxy renderowane tylko dla `user.role === 'admin'`.
- Bez stylów druku — to widok roboczy. Do podpisu służy Karta.

### Endpoint `POST /api/schedule/entries/apply-work-time`

`routes/api.js`, `requireRole('admin')` — spójnie z `PUT /schedule/entry/:id/times`
(`routes/api.js:607`), bo obie operacje ruszają podstawę wypłaty.

Body: `{ ids: [entryId, ...] }`.

Dla każdego id: wczytać wpis wraz ze statusem grafiku; pominąć, jeśli grafik nie jest
`approved` albo brakuje któregoś z odbić. Dla pozostałych:

```sql
UPDATE schedule_entries
SET custom_start=?, custom_end=?, shift_template_id=NULL
WHERE id=?
```

gdzie wartości to `HH:MM` wycięte z `work_started_at` / `work_ended_at` — dokładnie ta
sama operacja co dzisiejsza ręczna edycja godzin w Karcie.

Odpowiedź: `{ ok: true, applied, skipped }`. Jeden wpis w logach na wywołanie:
`log(user, 'Przepisanie odbić do grafiku', 'Jan Kowalski, 08-2026: 7 dni')`.
Po sukcesie strona się przeładowuje.

Pusta lista `ids` → `{ ok: true, applied: 0, skipped: 0 }`, bez wpisu w logach.

## Poza zakresem

- Zmiany w Karcie czasu pracy poza dodaniem przycisku przełączającego.
- Widok tygodniowy i zbiorczy dla wszystkich pracowników.
- Konfigurowalny próg tolerancji.
- Zaokrąglanie odbić przy przepisywaniu (przenoszone jest surowe `HH:MM`).
- Automatyczne odbijanie końca zmiany, zmiany spoza grafiku, powiadomienia o brakach.

## Testy

W repo nie ma frameworka ani skryptu `npm test` — jest jeden plik
`test/vendor-api.test.js` na czystym `assert`, uruchamiany ręcznie. Nowy plik
`test/work-time.test.js` w tej samej konwencji, uruchamiany przez
`node test/work-time.test.js`, pokrywa funkcje czyste z `utils/workTime.js`:

- zmiana nocna przez północ (koniec z datą następnego dnia) — dodatnie godziny faktyczne
- start bez końca → status `do_sprawdzenia`, `diff === null`
- brak obu odbić → status `do_sprawdzenia`, `diff === null`
- próg 15 minut po obu stronach: 14 min → `zgodne`, 15 min → `roznica`; tak samo na minus
- `totalDiff` liczone wyłącznie z dni z pełnym odbiciem; `totalPlanned` ze wszystkich dni
- `totalDiff !== totalActual - totalPlanned`, gdy w miesiącu jest dzień bez odbicia

Reszta — weryfikacja klikiem w przeglądarce: raport, przełączanie widoków, CSV,
przepisanie zaznaczonych dni i sprawdzenie, że Karta pokazuje nowe godziny.
