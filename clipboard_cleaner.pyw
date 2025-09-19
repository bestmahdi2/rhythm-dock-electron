# clipboard_cleaner.py

import pyperclip
import time
import re
import argparse
import sys
import subprocess

# --- Platform-Specific Import ---
IS_WINDOWS = sys.platform == 'win32'
if IS_WINDOWS:
    try:
        import win32gui
    except ImportError:
        print("Windows detected, but 'pywin32' is not installed.")
        print("Please run: pip install pywin32")
        IS_WINDOWS = False

# --- Configuration ---
TARGET_WINDOWS = [
    # 'gemini',
    # 'gpt',
    # 'github',
    # 'telegram',
    # '@',
]

# --- NEW: Linux-Specific Configuration ---
# Set this to False if you get 'xdotool' errors (common in WSL).
# When False, the script will stop trying to get the window title on Linux
# and will clean text from ALL applications, ignoring the TARGET_WINDOWS list.
CHECK_WINDOW_TITLES_ON_LINUX = False


def get_active_window_title():
    """
    Gets the title of the currently active window.
    """
    try:
        if IS_WINDOWS:
            hwnd = win32gui.GetForegroundWindow()
            return win32gui.GetWindowText(hwnd)
        # --- MODIFIED: Only run on Linux if the setting is True ---
        elif not IS_WINDOWS and CHECK_WINDOW_TITLES_ON_LINUX:
            result = subprocess.check_output(['xdotool', 'getactivewindow', 'getwindowname'], text=True,
                                             stderr=subprocess.DEVNULL)
            return result.strip()
        else:
            # Return None if on Linux and checking is disabled
            return None
    except Exception:
        return None


def clean_clipboard_text(text):
    """
    Removes a leading '+' or '-' character from each line of the text.
    """
    if not isinstance(text, str):
        return text, False

    lines = text.splitlines()
    cleaned_lines = []
    text_was_changed = False

    for line in lines:
        if re.match(r'^(\+|-)', line):
            cleaned_lines.append(line[1:])
            text_was_changed = True
        else:
            cleaned_lines.append(line)

    return "\n".join(cleaned_lines), text_was_changed


def main(args):
    """
    Main loop to monitor and clean the clipboard.
    """
    if not args.silent:
        print("Clipboard Cleaner is running...")
        if TARGET_WINDOWS:
            # --- MODIFIED: Show a warning if whitelist is ignored on Linux ---
            if not IS_WINDOWS and not CHECK_WINDOW_TITLES_ON_LINUX:
                print("NOTE: On Linux, window title checking is disabled. Whitelist will be ignored.")
            else:
                print(f"Monitoring for windows with titles containing: {TARGET_WINDOWS}")
        else:
            print("Monitoring all windows.")

    last_processed_text = pyperclip.paste()

    while True:
        try:
            current_text = pyperclip.paste()

            if current_text != last_processed_text:
                window_title = get_active_window_title()

                should_process = False

                # --- MODIFIED: Whitelist Logic ---
                # On Linux, if title checking is off, we default to processing everything.
                is_linux_with_no_check = not IS_WINDOWS and not CHECK_WINDOW_TITLES_ON_LINUX

                if is_linux_with_no_check:
                    should_process = True
                elif not TARGET_WINDOWS:
                    should_process = True
                elif window_title:
                    for target in TARGET_WINDOWS:
                        if target.lower() in window_title.lower():
                            should_process = True
                            break
                    else:
                        print(f"Change detected from: {window_title or 'Unknown Window'}")

                if should_process:
                    cleaned_text, was_changed = clean_clipboard_text(current_text)

                    if was_changed:
                        if not args.silent:
                            print("-" * 40)
                            print(f"Change detected from: {window_title or 'Unknown Window'}")
                            print("Cleaned text and updated clipboard.")

                        pyperclip.copy(cleaned_text)
                        last_processed_text = cleaned_text
                    else:
                        last_processed_text = current_text
                else:
                    last_processed_text = current_text

            time.sleep(0.5)

        except pyperclip.PyperclipException:
            last_processed_text = ""
            time.sleep(1)
        except KeyboardInterrupt:
            if not args.silent:
                print("\nClipboard Cleaner stopped.")
            break


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Monitors and cleans clipboard text.")
    parser.add_argument(
        "--silent",
        action="store_true",
        help="Run the script without any console output."
    )
    args = parser.parse_args()
    main(args)