!include "LogicLib.nsh"

; electron-builder already restores the current NSIS install directory when the
; same app GUID is present. This fallback also recognizes the old Squirrel/NSIS
; uninstall entry used by earlier Jacky Image builds.
!macro customInit
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R0 == ""
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jacky Image" "InstallLocation"
    ${If} $R1 == ""
      ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jacky Image" "InstallLocation"
    ${EndIf}
    ${If} $R1 != ""
      ${If} ${FileExists} "$R1\*.*"
        StrCpy $INSTDIR "$R1"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
