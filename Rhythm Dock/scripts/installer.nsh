!include nsDialogs.nsh

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Rhythm Dock Setup"
  !define MUI_WELCOMEPAGE_TEXT "This wizard will guide you through installing Rhythm Dock.$\r$\n$\r$\nChoose who can use the app and where its program files are installed.$\r$\n$\r$\nYour library, playlists, lyrics and settings are stored separately from the program files and are kept when you upgrade or uninstall.$\r$\n$\r$\nClose Rhythm Dock before continuing."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom RhythmSetupGuide

Function RhythmSetupGuide
  ; Never let the installer/uninstaller own a folder containing user databases.
  IfFileExists "$INSTDIR\lyrics.db" unsafeDataFolder
  IfFileExists "$INSTDIR\data\lyrics.db" unsafeDataFolder
  IfFileExists "$INSTDIR\RhythmDockData\*.*" unsafeDataFolder
  StrCpy $0 "$APPDATA\RhythmDock"
  StrLen $1 $0
  StrCpy $2 $INSTDIR $1
  StrCmp $2 $0 unsafeDataFolder
  Goto safeDataFolder
  unsafeDataFolder:
    MessageBox MB_ICONSTOP|MB_OK "This folder contains Rhythm Dock user data. Setup will stop to protect your database. Run Setup again and choose a separate folder for the application."
    Quit
  safeDataFolder:
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Ready to install" "Your music and library stay separate from the application."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "Program folder:$\r$\n$INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0 36u 100% 72u "After installation:$\r$\n1. Open Settings > Library and add your music folders.$\r$\n2. Choose Rhythm Dock as your default player in Windows Settings if desired.$\r$\n3. Enable Close to Tray to keep playing when the window closes."
  Pop $0
  ${NSD_CreateLabel} 0 116u 100% 40u "Existing databases, playlists and settings are preserved. Installing in another folder does not reset your library. Uninstalling removes the app, not your music or library data."
  Pop $0
  nsDialogs::Show
FunctionEnd
!macroend
