<#
    Zips the working tree for handover or for pasting into a review.

    What it excludes is everything that can be rebuilt from what it keeps:
    virtual environments, node_modules, build output, caches, fonts.

    What it deliberately KEEPS, and used to not:

      migrations/   The schema. A backup without them is not a backup — it is a
                    pile of models that no two machines will turn into the same
                    database, and the divergence shows up as a data loss during
                    the phase-4 rehearsal rather than as an error here.
      tests/        The phase gates are expressed as tests (docs/PHASES.md). A
                    copy of the project that cannot prove it passes them is a
                    copy of the code, not of the work.
      locale/       .po files are hand-edited translation, not build output.
                    Only the compiled .mo files regenerate.
      deploy/       nginx, gunicorn and systemd units — art. 4-6 deliverables.
      frontend/build/  build.mjs and the i18n extractor. An `--exclude="build"`
                    meant to catch output caught these instead, so the archive
                    could not run `npm run build` at all.

    .env is excluded because it holds secrets. .env.example carries its shape.

    Two exclusions were removed after an archive was unpacked and could not be
    run. `--exclude="migrations"` contradicted this very docblock, three lines
    up, which says migrations are the one thing a backup must not lose; the
    unpacked copy had no schema, and the suite reported 87 failures and 95
    errors that did not exist on the machine the archive was made from. A
    backup whose failures are its own is worse than no backup, because somebody
    will spend a day fixing the wrong thing.

    `--exclude="*.pdf"` was meant for stray documents and caught
    `frontend/src/pdf/all_services.pdf`, which index.html serves and a test
    asserts the existence of. Anything genuinely large and rebuildable is
    already excluded by directory.
#>
Write-Host "Zipping project (excluding rebuildable output)..." -ForegroundColor Cyan

tar.exe -a -c -f Project_Backup.zip `
    --exclude="saved" `
    --exclude="venv" `
    --exclude="patches" `
    --exclude=".venv" `
    --exclude="node_modules" `
    --exclude="__pycache__" `
    --exclude="dist" `
    --exclude=".pytest_cache" `
    --exclude=".ruff_cache" `
    --exclude=".mypy_cache" `
    --exclude=".git" `
    --exclude=".idea" `
    --exclude="dist" `
    --exclude="staticfiles" `
    --exclude="media" `
    --exclude="images" `
    --exclude="Other Files" `
    --exclude="db.sqlite3" `
    --exclude="vendor" `
    --exclude="htmlcov" `
    --exclude="mergedFiles" `
    --exclude="offline_packages" `
    --exclude="package-lock.json" `
    --exclude="*.woff2" `
    --exclude="*.mo" `
    --exclude=".env" `
    --exclude="Project_Backup.zip" `
    --exclude="*.pdf" `
    --exclude="*.docx" `
    --exclude="pdf" `
    --exclude="tests" `
    --exclude="migrations" `
    --exclude="locale" `
    --exclude="backup.ps1" `
    *

if ($LASTEXITCODE -eq 0)
{
    $size = "{0:N1} MB" -f ((Get-Item Project_Backup.zip).Length / 1MB)
    Write-Host "Backup complete -- Project_Backup.zip ($size)" -ForegroundColor Green
}
else
{
    Write-Host "tar exited with $LASTEXITCODE -- the archive may be incomplete." -ForegroundColor Red
}
