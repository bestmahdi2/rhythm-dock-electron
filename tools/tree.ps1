<#
.SYNOPSIS
    Displays a directory structure for a Node.js/Electron project.

.DESCRIPTION
    This PowerShell script lists the contents of the current directory recursively,
    excluding common development and build folders as defined in the $ExcludeList.
    It serves as a Windows-native replacement for the original tree.sh script.
#>

# --- EDIT THIS LIST TO CHANGE THE EXCLUDED ITEMS ---
$ExcludeList = @(
    ".idea",
    ".git",
    ".github",
    ".vscode",
    "dist",
    "release",
    "build",
    "mergedFiles",
    "backups",
    "node_modules",

    # Project specific files
    "lyrics.db",
    "lyrics.db-shm",
    "lyrics.db-wal",
    "package-lock.json",

    # Scripts
    "manage.sh",
    "manage.ps1",
    "tree.sh",
    "tree.ps1",
    "consolidate.py",

    # Common log/temp files
    "*.log",
    "*.tmp"
)

# --- Main Logic ---

# We define a custom function to handle the directory traversal manually.
# This gives us full control over which directories to enter.
function Get-TreeItem
{
    param(
        [string]$Path,
        [int]$Depth
    )

    # Get only the *immediate* children. We do NOT use -Recurse here.
    # We use -ErrorAction SilentlyContinue to prevent errors for restricted folders.
    $children = Get-ChildItem -Path $Path -Force -ErrorAction SilentlyContinue

    foreach ($child in $children)
    {
        # --- Filtering Logic ---
        # Check if the current child's name matches any pattern in the exclude list.
        $isExcluded = $false
        foreach ($pattern in $ExcludeList)
        {
            if ($child.Name -like $pattern)
            {
                $isExcluded = $true
                break # Found a match, no need to check further.
            }
        }

        # If the item is NOT excluded, we process it.
        if (-not $isExcluded)
        {
            # Create the indentation based on the current depth.
            $indent = "  " * $Depth

            # Display the item with the correct formatting and color.
            if ($child.PSIsContainer)
            {
                Write-Host "$( $indent )\-- $( $child.Name )" -ForegroundColor Yellow
            }
            else
            {
                Write-Host "$( $indent )|-- $( $child.Name )"
            }

            # IMPORTANT: If the item was a directory, we now recurse into it.
            # This only happens for directories that were not excluded.
            if ($child.PSIsContainer)
            {
                Get-TreeItem -Path $child.FullName -Depth ($Depth + 1)
            }
        }
    }
}

Write-Host "Displaying project structure with exclusion list..." -ForegroundColor Cyan
Write-Host "----------------------------------------------------" -ForegroundColor Cyan

# Start the recursion from the current directory at depth 0.
Get-TreeItem -Path . -Depth 0