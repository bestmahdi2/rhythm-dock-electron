# manage.ps1 — Electron Project Automation Script
# A PowerShell adaptation of the original bash script for the Windows environment.

# ------------------ CONFIG ------------------
$VERSION = "1.0.2" # Initial version for this project
$DB_FILE = "lyrics.db" # The new SQLite database file
$DB_BACKUP_DIR = "backups" #
$BATCH_MODE = $false # Global flag to control interactive pauses
# GIT_REPO_URL is not actively used in the script's logic, but kept for reference
$GIT_REPO_URL = "git@github.com:bestmahdi2/rhythm-dock-electron.git"

# ------------------ MESSAGING & HELPERS ------------------
# PowerShell uses Write-Host with -ForegroundColor for colored output.
function msg_info { param($message) Write-Host "`n[INFO] $message" -ForegroundColor Blue }
function msg_warn { param($message) Write-Host "`n[WARN] $message" -ForegroundColor Yellow }
function msg_error { param($message) Write-Host "`n[ERROR] $message" -ForegroundColor Red }
function msg_ok { param($message) Write-Host "`n[OK] $message" -ForegroundColor Green }
$SEPARATOR = "----------------------------------------------------------------------"

function print_title {
    param($title)
    Clear-Host
    Write-Host "====================================`n" -ForegroundColor Cyan
    Write-Host "      $title`n" -ForegroundColor Green
    Write-Host "====================================" -ForegroundColor Cyan
    Write-Host
}

function pause {
    if ($BATCH_MODE) { return }
    Write-Host
    Read-Host "Press [Enter] to continue..."
}

# ------------------ TASK FUNCTIONS ------------------

function install_dependencies {
    print_title "Installing Node.js Dependencies"
    msg_info "Running 'npm install'. This may take a moment..."
    Write-Host $SEPARATOR -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        msg_error "npm install failed. Please check for errors."
        pause 
        return 1
    }
    Write-Host $SEPARATOR -ForegroundColor Cyan
    msg_ok "Dependencies installed successfully."
    pause
    return 0
}

function run_app {
    print_title "Running App in Development Mode"
    msg_info "Executing 'npm start'. Press Ctrl+C in the new window or here to stop."
    Write-Host $SEPARATOR -ForegroundColor Cyan
    # 'npm start' is often a long-running process, so direct execution is fine.
    npm start
    pause
    return 0
}

function build_and_return {
    print_title "Building from Root Directory"

    # Check if the project directory exists
    if (-not (Test-Path -Path "Rhythm Dock")) {
        msg_error "Directory 'Rhythm Dock' not found from current location."
        pause
        return 1
    }

    # Use Push/Pop-Location for safer directory changes
    msg_info "Entering 'Rhythm Dock' directory..."
    Push-Location -Path "Rhythm Dock"

    msg_info "Executing 'npm run dist'..."
    Write-Host $SEPARATOR -ForegroundColor Cyan
    npm run dist
    if ($LASTEXITCODE -ne 0) {
        msg_error "Build failed. Please check the output for errors."

        # Always return to the original directory, even on failure
        Pop-Location
        pause
        return 1
    }
    Write-Host $SEPARATOR -ForegroundColor Cyan
    msg_ok "Application built successfully."

    msg_info "Returning to original directory..."
    Pop-Location # This will take you back to where you started
    pause
    return 0
}

function manual_commands {
    print_title "Manual Commands Shell"
    msg_info "Opening a new PowerShell shell. Node.js and npm are available in your PATH."
    msg_warn "Type 'exit' to return to the menu."
    pwsh
}

function backup_db {
    print_title "Backup Database"
    msg_info "Starting database backup..."
    if (-not (Test-Path -Path $DB_FILE -PathType Leaf)) {
        msg_warn "DB file not found: '$DB_FILE'. Nothing to back up."
        pause
        return 1
    }
    # Create directory if it doesn't exist
    if (-not (Test-Path -Path $DB_BACKUP_DIR)) {
        New-Item -Path $DB_BACKUP_DIR -ItemType Directory | Out-Null
    }
    $ts = Get-Date -Format "yyyyMMdd_HHmmss"
    $dest = Join-Path -Path $DB_BACKUP_DIR -ChildPath "$(Split-Path $DB_FILE -Leaf)_${ts}.bak"
    Copy-Item -Path $DB_FILE -Destination $dest
    msg_ok "Database successfully backed up to $dest"
    pause
    return 0
}

function restore_db {
    print_title "Restore Database"
    msg_info "Searching for backups in '$DB_BACKUP_DIR'..."
    if (-not (Test-Path -Path $DB_BACKUP_DIR)) {
        msg_warn "Backup directory not found. Cannot restore."
        pause
        return 1
    }
    # Get the most recent .bak file
    $latest = Get-ChildItem -Path $DB_BACKUP_DIR -Filter *.bak | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) {
        msg_warn "No backups found in $DB_BACKUP_DIR."
        pause
        return 1
    }

    msg_info "Latest backup found: $($latest.FullName)"
    $ans = Read-Host "Restore this backup? This will overwrite the current DB. (y/N)"
    if ($ans -eq 'y') {
        msg_info "Restoring backup to '$DB_FILE'..."
        Copy-Item -Path $latest.FullName -Destination $DB_FILE -Force
        msg_ok "Restore complete."
    }
    else {
        msg_warn "Restore cancelled."
    }
    pause
}

function clean_project {
    print_title "Cleaning Project"
    $c = Read-Host "This will remove node_modules, dist, and release directories. Continue? (y/N)"
    if ($c -ne 'y') {
        msg_warn "Cancelled."
        pause
        return 1
    }

    Write-Host $SEPARATOR -ForegroundColor Cyan
    msg_info "Removing node_modules..."
    if (Test-Path "node_modules") { Remove-Item -Recurse -Force -Path "node_modules" }
    msg_info "Removing build directories (dist, release)..."
    if (Test-Path "dist") { Remove-Item -Recurse -Force -Path "dist" }
    if (Test-Path "release") { Remove-Item -Recurse -Force -Path "release" }
    msg_ok "Project directories cleaned."
    Write-Host $SEPARATOR -ForegroundColor Cyan
    pause
}

function hard_reset {
    param($args)
    print_title "HARD RESET"
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" -ForegroundColor Red
    Write-Host "WARNING: THIS IS A DESTRUCTIVE OPERATION." -ForegroundColor Yellow
    Write-Host "This will permanently delete:"
    Write-Host "  - The database file ($DB_FILE)"
    Write-Host "  - All installed dependencies (node_modules)"
    Write-Host "  - All build artifacts (dist, release)"
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" -ForegroundColor Red

    $confirmation = ""
    if (($args -eq "-y") -or ($args -eq "--yes")) {
        $confirmation = "YES, DELETE EVERYTHING"
        msg_warn "'-y' flag detected. Bypassing manual confirmation."
    }
    else {
        $confirmation = Read-Host "To confirm, type 'YES, DELETE EVERYTHING' and press [Enter]"
    }

    if ($confirmation -ne "YES, DELETE EVERYTHING") {
        msg_warn "Hard reset cancelled."
        pause
        return 1
    }

    msg_info "Proceeding with Hard Reset..."
    Write-Host $SEPARATOR -ForegroundColor Cyan
    msg_info "Deleting database file..."
    if (Test-Path $DB_FILE) { Remove-Item -Force $DB_FILE }
    msg_info "Deleting dependencies and build directories..."
    if (Test-Path "node_modules") { Remove-Item -Recurse -Force "node_modules" }
    if (Test-Path "dist") { Remove-Item -Recurse -Force "dist" }
    if (Test-Path "release") { Remove-Item -Recurse -Force "release" }
    Write-Host $SEPARATOR -ForegroundColor Cyan
    msg_ok "Hard Reset complete. Run 'Install Dependencies' to continue."
    pause
    return 0
}

function guide_ssh_setup {
    # This function is largely informational and translates directly.
    print_title "SSH Key Setup Guide for GitHub"
    msg_error "The error 'Permission denied (publickey)' means GitHub doesn't recognize your computer."
    msg_info "Follow these steps to create an SSH key and add it to your GitHub account."
    Write-Host $SEPARATOR -ForegroundColor Cyan
    Write-Host "`nStep 1: Check for existing SSH keys" -ForegroundColor Yellow; Write-Host "ls -al ~/.ssh" -ForegroundColor Cyan
    Write-Host "`nStep 2: Generate a new SSH key if you don't have one" -ForegroundColor Yellow; Write-Host 'ssh-keygen -t ed25519 -C "your_email@example.com"' -ForegroundColor Cyan
    Write-Host "`nStep 3: Add your new key to the ssh-agent" -ForegroundColor Yellow; Write-Host 'eval "$(ssh-agent -s)"; ssh-add ~/.ssh/id_ed25519' -ForegroundColor Cyan
    Write-Host "`nStep 4: Copy your public key to the clipboard" -ForegroundColor Yellow; Write-Host "cat ~/.ssh/id_ed25519.pub" -ForegroundColor Cyan; Write-Host "(On Windows, you might use: Get-Content ~/.ssh/id_ed25519.pub | Set-Clipboard)"
    Write-Host "`nStep 5: Add your public key to your GitHub account" -ForegroundColor Yellow; Write-Host "1. Open: https://github.com/settings/keys" -ForegroundColor Green; Write-Host "2. Click 'New SSH key', give it a title, and paste the key."
    Write-Host "`n$SEPARATOR" -ForegroundColor Cyan; msg_ok "Once done, run the update command again."; pause
}

function project_update {
    print_title "Updating Project from Git"
    if (-not (Test-Path ".git")) {
        msg_error "This is not a Git repository. Cannot update."
        pause
        return 1
    }

    msg_info "Stashing local changes..."
    git stash
    msg_info "Saving current version in case of rollback..."
    $ORIG_HEAD = git rev-parse HEAD
    msg_info "Pulling latest version from the 'master' branch..."
    # Execute git pull and capture all output streams to a variable
    $pull_output = (git pull origin master 2>&1)
    $pull_status = $LASTEXITCODE

    if ($pull_status -ne 0) {
        git stash pop > $null
        if ($pull_output -like "*Permission denied (publickey)*") {
            guide_ssh_setup
        }
        else {
            msg_error "Git pull failed. Please check for conflicts or connection issues."; Write-Host "$pull_output" -ForegroundColor Red
        }
        pause
        return 1
    }
    msg_ok "Successfully pulled the latest version."
    msg_warn "Starting automated project setup after update..."

    # Execute command sequence: Hard reset (-y) then npm install
    $sequence_status = execute_command_sequence "5-y,31"
    if ($sequence_status -ne 0) {
        msg_error "The post-update process failed. Reverting to the previous version."
        git reset --hard "$ORIG_HEAD"
        msg_ok "Successfully rolled back to the previous version."
        pause
        return 1
    }
    msg_ok "Project update and setup completed successfully."
    pause
    return 0
}

# --- UNCHANGED UTILITIES ---
function run_tree {
    print_title "Project Directory Tree"
    # Check for the new .ps1 file
    if (Test-Path -Path "./tree.ps1" -PathType Leaf) {
        # Execute the powershell script
        ./tree.ps1
    } else {
        msg_warn "tree.ps1 not found."
    }
    pause
}

function run_consolidate {
    print_title "Consolidating Project Files"
    if (Test-Path -Path "consolidate.py" -PathType Leaf) {
        python.exe ./consolidate.py
    } else {
        msg_warn "consolidate.py not found."
    }
    pause
}


# ------------------ MENUS & DISPATCHER ------------------

function dispatch_command {
    param($command_token)
    $code = $command_token
    $args = ""
    if ($command_token -like "*-*") {
        $parts = $command_token.Split('-', 2)
        $code = $parts[0]
        $args = "-$($parts[1])"
    }

    $main_choice = $code.Substring(0, 1)
    $sub_choice = if ($code.Length -gt 1) { $code.Substring(1, 1) } else { "" }
    $cmd_status = 0

    switch ($main_choice) {
        "1" { $cmd_status = run_app }
        "2" { $cmd_status = build_app }
        "3" { # Data & Setup Menu
            switch ($sub_choice) {
                "1" { $cmd_status = install_dependencies }
                "2" { $cmd_status = backup_db }
                "3" { $cmd_status = restore_db }
                "4" { $cmd_status = clean_project }
                default { msg_error "Invalid command code: $code"; $cmd_status = 1 }
            }
        }
        "4" { # Git & Utilities Menu
            switch ($sub_choice) {
                "1" { $cmd_status = project_update }
                "2" { $cmd_status = run_tree }
                "3" { $cmd_status = run_consolidate }
                "4" { $cmd_status = manual_commands }
                default { msg_error "Invalid command code: $code"; $cmd_status = 1 }
            }
        }
        "5" { $cmd_status = hard_reset $args }
        default { msg_error "Invalid command code: $code"; $cmd_status = 1 }
    }
    return $cmd_status
}

function execute_command_sequence {
    param($sequence)
    $global:BATCH_MODE = $true
    msg_warn "Executing command sequence: '$sequence'. Pauses will be skipped."
    $tokens = $sequence.Split(',')
    foreach ($token in $tokens) {
        $trimmed_token = $token.Trim()
        if ($trimmed_token) {
            $status = dispatch_command $trimmed_token
            if ($status -ne 0) {
                msg_error "Command '$trimmed_token' in sequence failed. Aborting."
                $global:BATCH_MODE = $false
                pause 
                return 1
            }
        }
    }
    $global:BATCH_MODE = $false
    msg_ok "Command sequence finished."
    return 0
}

function menu_data_setup {
    while ($true) {
        print_title "Project Setup & Data"
        Write-Host "1. Install Dependencies (npm install)"
        Write-Host "2. Backup Database"
        Write-Host "3. Restore Database"
        Write-Host "4. Clean Project (node_modules, dist)"
        Write-Host "0. Back to Main Menu"
        Write-Host "------------------------------------"
        $choice = Read-Host "Enter your choice"
        switch ($choice) {
            "1" { install_dependencies }
            "2" { backup_db }
            "3" { restore_db }
            "4" { clean_project }
            "0" { break }
            default { msg_error "Invalid choice."; pause }
        }
    }
}

function menu_git_utils {
    while ($true) {
        print_title "Git & Utilities"
        Write-Host "1. Update Project from Git"
        Write-Host "2. Show Project Tree"
        Write-Host "3. Consolidate Project Files"
        Write-Host "4. Manual Commands (shell)"
        Write-Host "0. Back to Main Menu"
        Write-Host "------------------------------------"
        $choice = Read-Host "Enter your choice"
        switch ($choice) {
            "1" { project_update }
            "2" { run_tree }
            "3" { run_consolidate }
            "4" { manual_commands }
            "0" { break }
            default { msg_error "Invalid choice."; pause }
        }
    }
}

# ------------------ COMMAND-LINE INTERFACE ------------------
function show_usage {
    Write-Host "Usage: ./manage.ps1 [command]"
    Write-Host "`nCommands:"
    Write-Host "  start                 Run the app in development mode (npm start)."
    Write-Host "  build                 Build the application for distribution (npm run dist)."
    Write-Host "  install               Install/update node_modules (npm install)."
    Write-Host "  pull                  Update the project from Git and run the setup sequence."
    Write-Host "  clean                 Clean build artifacts and node_modules."
    Write-Host "  reset                 Perform a hard reset of the project (deletes DB, node_modules)."
    Write-Host "  backup                Backup the current database."
    Write-Host "  restore               Restore the latest database backup."
    Write-Host "  help                  Show this help message."
    Write-Host "`nIf no command is given, the interactive menu will be shown."
}

# ------------------ SCRIPT ENTRYPOINT ------------------

function run_and_exit {
    param(
        [scriptblock]$command
    )
    # Execute the command AND CAPTURE ITS RETURN VALUE into the $status variable.
    # This is the main fix for the exit issue.
    $status = & $command

    # If the command returned a non-zero exit code, it means there was an error.
    if ($status -ne 0) {
        # The pause is now handled within the function that failed,
        # but we'll leave this here as a fallback.
        pause
    }

    # Exit with the status code from the command
    exit $status
}

# In PowerShell, command-line arguments are in the automatic $args array.
if ($args.Count -gt 0) {
    switch ($args[0]) {
        "start"   { run_and_exit { run_app } }
        "build"   { run_and_exit { build_app } }
        "install" { run_and_exit { install_dependencies } }
        "pull"    { run_and_exit { project_update } }
        "clean"   { run_and_exit { clean_project } }
        "reset"   { run_and_exit { hard_reset } }
        "backup"  { run_and_exit { backup_db } }
        "restore" { run_and_exit { restore_db } }
        "help"    { show_usage; exit 0 }
        "-h"      { show_usage; exit 0 }
        "--help"  { show_usage; exit 0 }
        default   { msg_error "Unknown command: $($args[0])"; show_usage; pause; exit 1 }
    }
}

# Interactive Menu Loop
while ($true) {
    print_title "ELECTRON PROJECT MENU [v$($VERSION)]"
    Write-Host "1. Run App (npm start)"
    Write-Host "2. Build App for Distribution (npm run dist)"
    Write-Host "3. Project Setup & Data"
    Write-Host "4. Git & Utilities"
    Write-Host "5. Hard Reset Project" -ForegroundColor Red
    Write-Host "6. Exit"
    Write-Host "====================================" -ForegroundColor Cyan
    $choice = Read-Host "Enter your choice or a command sequence (e.g., 5-y,31)"

    if ($choice -like "*,*") {
        execute_command_sequence $choice
        continue
    }

    # The logic for choosing from the menu
    switch ($choice) {
        "1" { run_app }
        "2" { build_app }
        "3" { menu_data_setup }
        "4" { menu_git_utils }
        "5" { hard_reset }
        "6" { break }
        default { msg_error "Invalid choice. Please try again."; pause }
    }
}

msg_ok "Exiting script. Goodbye!"