; KillCam was renamed KeroCam in 2.2. Copies installed before that live under
; the old product name: their own folder, Start menu entry, uninstall entry and
; startup entry. Remove that copy when KeroCam goes in, so updating doesn't
; leave two apps behind.
;
; Settings and the library index are not touched: they live under the app
; identifier (%APPDATA%\com.jkeroro.killcam), which stays the same, and the
; recordings folder is wherever the user picked. The old uninstaller only
; deletes app data when its checkbox is ticked, and /S never shows it.

Var KeroOldDir

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $KeroOldDir HKCU "Software\Jkeroro\KillCam" ""
  ${If} $KeroOldDir == ""
    StrCpy $KeroOldDir "$LOCALAPPDATA\KillCam"
  ${EndIf}
  ${If} ${FileExists} "$KeroOldDir\uninstall.exe"
  ${AndIf} $KeroOldDir != $INSTDIR
    DetailPrint "Removing the old KillCam install from $KeroOldDir"
    ExecWait '"$KeroOldDir\uninstall.exe" /S _?=$KeroOldDir'
    Delete "$KeroOldDir\uninstall.exe"
    RMDir "$KeroOldDir"
  ${EndIf}
  ; KeroCam writes its own startup entry on first launch if the setting is on
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "KillCam"
!macroend
