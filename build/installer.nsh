; Custom NSIS include for RTMP Overlay Server installer.
; Overrides the built-in running-app check for both installer and uninstaller
; so the user is never prompted to manually close the app.

; ── Installer: skip the "app is running" check, just force-kill ──
!macro customCheckAppRunning
  nsExec::ExecToStack 'taskkill /f /im "RTMP Overlay Server.exe"'
  Pop $0
  nsExec::ExecToStack 'taskkill /f /im ffmpeg.exe'
  Pop $0
  Sleep 1500
!macroend

; ── Uninstaller: same — force-kill so silent upgrades work ──
!macro customUnCheckAppRunning
  nsExec::ExecToStack 'taskkill /f /im "RTMP Overlay Server.exe"'
  Pop $0
  nsExec::ExecToStack 'taskkill /f /im ffmpeg.exe'
  Pop $0
  Sleep 1500
!macroend
