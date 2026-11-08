; This is a per-user installer. Explicitly restart the installed executable when
; requested by electron-updater; shell-broker shortcut launching is unreliable
; on some Windows sessions. The app's single-instance lock handles the standard
; NSIS launch too if its shell broker succeeds.
!macro customInstall
  ${if} ${isForceRun}
  ${andIf} ${Silent}
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
  ${endIf}
!macroend
