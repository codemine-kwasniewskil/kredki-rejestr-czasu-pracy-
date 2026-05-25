# Kredki Cafe – Rejestr Czasu Pracy

System zarządzania grafikiem i czasem pracy pracowników kawiarni.

## Uruchomienie

```bash
npm install
node server.js
```

Aplikacja dostępna pod: http://localhost:3000

**Domyślne konto admina:** `admin@cafe.com` / `admin123`

## Role użytkowników

| Rola | Uprawnienia |
|------|-------------|
| `admin` | Pełen dostęp, zatwierdzanie grafików, zarządzanie użytkownikami |
| `location_manager` | Tworzenie/edycja grafiku, zarządzanie umowami i szablonami zmian |
| `worker` | Podgląd grafiku, ustawianie dostępności |

## Funkcjonalności

- **Logowanie** – każdy użytkownik ma własne konto
- **Grafik tygodniowy** – widok kalendarza (pracownicy × dni), drag & drop zmian
- **Szablony zmian** – definiuj zmiany np. "Rano 7-15", "Popołudnie 12-19"
- **Dostępność** – pracownicy zaznaczają dni zielony/czerwony (dostępny/niedostępny)
- **Umowy** – minimalne godziny tygodniowe, pasek postępu na grafiku
- **Przepływ akceptacji** – szkic → oczekuje na akceptację → zatwierdzone/odrzucone

## Stos technologiczny

- Node.js + Express (backend)
- EJS (szablony HTML)
- Tailwind CSS via CDN (stylowanie)
- SQLite via node-sqlite3-wasm (baza danych, bez kompilacji natywnej)
- Vanilla JS + HTML5 Drag & Drop

## Struktura bazy danych

```
users          – użytkownicy i role
contracts      – umowy (min. godz./tydz.)
shift_templates– szablony zmian
schedules      – grafiki tygodniowe (status: szkic/oczekuje/zatwierdzony/odrzucony)
schedule_entries– wpisy w grafiku
availability   – dostępność pracowników (dzień po dniu)
```
