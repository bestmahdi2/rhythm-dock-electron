# consolidate.py (Adapted for Node.js / Electron)
# Place this script in the root of your Electron project and run it from there.

import os
from pathlib import Path

# --- Configuration ---

# 1. Define the directory where consolidated files will be saved.
OUTPUT_DIR_NAME = "mergedFiles"

# 2. Define files or directories to exclude from consolidation.
EXCLUDE_FILES = ["consolidate.py"]
# We'll also exclude dotfiles/dot-directories by default from broad searches.
EXCLUDE_DIRS = ["node_modules", ".git", ".vscode", ".idea", OUTPUT_DIR_NAME]

# 3. Define the jobs for gathering files.
#    Each job specifies a file type, a list of search patterns, an output file,
#    and the comment style for headers and footers.
GATHER_JOBS = [
    {
        "name": "Project Configuration",
        "search_patterns": ["package.json", ".gitignore", ".gitattributes", ".npmrc"],
        "output_file": "_project_configs.txt",
        "comments": {"start": "#", "end": ""},
    },
    {
        "name": "Documentation",
        "search_patterns": ["*.md"],
        "output_file": "_project_documentation.md",
        "comments": {"start": ""},
    },
    {
        "name": "Electron Main Process",
        "search_patterns": ["src/main.js", "src/preload.js"],
        "output_file": "_electron_main_process.js",
        "comments": {"start": "//", "end": ""},
    },
    {
        "name": "Electron Renderer Scripts",
        "search_patterns": ["src/renderer/renderer.js"],
        "output_file": "_electron_renderer_scripts.js",
        "comments": {"start": "//", "end": ""},
    },
    {
        "name": "HTML Views",
        "search_patterns": ["src/renderer/**/*.html"],
        "output_file": "_electron_views.html",
        "comments": {"start": ""},
    },
    {
        "name": "Stylesheets",
        "search_patterns": ["src/renderer/**/*.css"],
        "output_file": "_electron_styles.css",
        "comments": {"start": "/*", "end": "*/"},
    },
]


def create_header(file_path, comment_start, comment_end):
    """Creates a formatted header for a file segment."""
    start_padding = " " if comment_end == "" else " "
    end_padding = " " if comment_end != "" else ""
    separator_line = f"{comment_start}{start_padding}{'-' * 80}{end_padding}{comment_end}"
    file_line = f"{comment_start}{start_padding}START OF FILE: {file_path}{end_padding}{comment_end}"
    return f"{separator_line}\n{file_line}\n{separator_line}\n\n"


def create_footer(comment_start, comment_end):
    """Creates a formatted footer for a file segment."""
    start_padding = " " if comment_end == "" else " "
    end_padding = " " if comment_end != "" else ""
    separator_line = f"{comment_start}{start_padding}{'-' * 80}{end_padding}{comment_end}"
    return f"\n{separator_line}\n\n\n"


def main():
    """Main function to run the consolidation jobs."""
    project_root = Path.cwd()
    output_dir = project_root / OUTPUT_DIR_NAME
    output_dir.mkdir(exist_ok=True)

    print(f"Starting file consolidation. Output will be in '{output_dir.relative_to(project_root)}/'\n")

    for job in GATHER_JOBS:
        job_name = job["name"]
        search_patterns = job["search_patterns"]
        output_file_path = output_dir / job["output_file"]
        comments = job.get("comments", {})
        comment_start = comments.get("start", "#")
        comment_end = comments.get("end", "")

        print(f"--- Running Job: {job_name} ---")

        all_files = []
        for pattern in search_patterns:
            # Use rglob for recursive search, which is more intuitive
            found_files = list(project_root.rglob(pattern)) if "**" in pattern else list(project_root.glob(pattern))
            all_files.extend(found_files)

        valid_files = [
            f for f in all_files
            if f.is_file() and f.name not in EXCLUDE_FILES and not any(part in EXCLUDE_DIRS for part in f.parts)
        ]

        if not valid_files:
            print(f"No files found for patterns: {search_patterns}. Skipping.\n")
            continue

        # Remove duplicates and sort
        valid_files = sorted(list(set(valid_files)))

        with open(output_file_path, "w", encoding="utf-8") as outfile:
            print(f"  Creating '{output_file_path.name}'...")
            for file_path in valid_files:
                relative_path = file_path.relative_to(project_root)
                print(f"    + Adding {relative_path}")

                header = create_header(relative_path, comment_start, comment_end)
                footer = create_footer(comment_start, comment_end)

                try:
                    content = file_path.read_text(encoding="utf-8", errors='ignore')
                    outfile.write(header)
                    outfile.write(content)
                    outfile.write(footer)
                except Exception as e:
                    error_message = f"Could not read file {relative_path}: {e}"
                    print(f"    ! ERROR: {error_message}")
                    outfile.write(header)
                    outfile.write(f"{comment_start} ERROR: {error_message} {comment_end}\n")
                    outfile.write(footer)
        print(f"--- Job '{job_name}' complete. ---\n")

    print("All consolidation jobs finished!")


if __name__ == "__main__":
    main()
