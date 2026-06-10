# Histology viewer

## PostgreSQL

Backend хранит препараты, диагностики и результаты тестирования в PostgreSQL.
По умолчанию используется подключение:

```bash
postgres://postgres:postgres@127.0.0.1:5432/histology_viewer
```

Для локального запуска БД:

```bash
docker compose up -d postgres
```

Если нужна другая БД, перед запуском backend задайте:

```bash
export DATABASE_URL="postgres://user:password@host:5432/database"
```

При первом старте backend создаёт таблицы и переносит данные из старых JSON-файлов
`server/data/slides.json`, `server/data/diagnostics.json`,
`server/data/diagnostic-results.json`, если соответствующие таблицы пустые.

## Запуск

В папке `server`:

```bash
npm run dev
```

Во втором терминале запустите frontend:

```bash
npm run dev -- --host 0.0.0.0
```

## Разработка и деплой

Код хранится в GitHub, а ветка `main` считается стабильной версией для сервера.
Изменения лучше делать в отдельных ветках и вливать в `main` через Pull Request.

Перед отправкой изменений:

```bash
npm run lint
npm run build
```

На сервере после обновления `main`:

```bash
./scripts/deploy.sh
```

Подробнее: `docs/development-workflow.md`.
