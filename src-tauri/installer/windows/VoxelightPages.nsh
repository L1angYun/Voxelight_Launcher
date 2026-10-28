!define VOXELIGHT_ART "${__FILEDIR__}\assets\scene.bmp"
!define VOXELIGHT_FONT_REGULAR "${__FILEDIR__}\assets\MiSans-Regular.ttf"
!define VOXELIGHT_FONT_SEMIBOLD "${__FILEDIR__}\assets\MiSans-Semibold.ttf"
!define VOXELIGHT_FR_PRIVATE 0x10

Var VoxelightArtHandle
Var VoxelightImage
Var VoxelightRun
Var VoxelightBodyFont
Var VoxelightSemiboldFont
Var VoxelightDisplayFont
Var VoxelightSmallFont
Var VoxelightRegularFontLoaded
Var VoxelightSemiboldFontLoaded
Var VoxelightInheritedHeaderFont

!define MUI_CUSTOMFUNCTION_GUIINIT VoxelightGuiInit
; MUI_PAGE_FUNCTION_FULLWINDOW expands ${MUI_PAGE_UNINSTALLER_FUNCPREFIX} into the
; function names it defines, so the installer page prefixes must be set first.
; Every MUI_PAGE_* macro relies on MUI_PAGE_INIT for this; custom pages must do it
; themselves (calling MUI_PAGE_INIT here would re-run MUI_INTERFACE too early and
; clash with the MUI_ICON/MUI_HEADERIMAGE defines below).
!ifndef MUI_PAGE_UNINSTALLER_PREFIX
  !define MUI_PAGE_UNINSTALLER_PREFIX ""
!endif
!ifndef MUI_PAGE_UNINSTALLER_FUNCPREFIX
  !define MUI_PAGE_UNINSTALLER_FUNCPREFIX ""
!endif
!insertmacro MUI_PAGE_FUNCTION_FULLWINDOW

Function VoxelightGuiInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\voxelight-scene.bmp "${VOXELIGHT_ART}"
  File /oname=$PLUGINSDIR\MiSans-Regular.ttf "${VOXELIGHT_FONT_REGULAR}"
  File /oname=$PLUGINSDIR\MiSans-Semibold.ttf "${VOXELIGHT_FONT_SEMIBOLD}"

  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\MiSans-Regular.ttf", i ${VOXELIGHT_FR_PRIVATE}, p 0) i .r0'
  StrCpy $VoxelightRegularFontLoaded $R0
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\MiSans-Semibold.ttf", i ${VOXELIGHT_FR_PRIVATE}, p 0) i .r0'
  StrCpy $VoxelightSemiboldFontLoaded $R0

  CreateFont $VoxelightBodyFont "MiSans" 9 400
  CreateFont $VoxelightSemiboldFont "MiSans" 10 600
  CreateFont $VoxelightDisplayFont "MiSans" 22 600
  CreateFont $VoxelightSmallFont "MiSans" 8 400

  StrCpy $VoxelightInheritedHeaderFont $mui.Header.Text.Font
  SendMessage $mui.Header.Text ${WM_SETFONT} $VoxelightSemiboldFont 1
  SendMessage $mui.Header.SubText ${WM_SETFONT} $VoxelightBodyFont 1
  SendMessage $mui.Branding.Text ${WM_SETFONT} $VoxelightSmallFont 1
  SendMessage $mui.Button.Next ${WM_SETFONT} $VoxelightBodyFont 1
  SendMessage $mui.Button.Back ${WM_SETFONT} $VoxelightBodyFont 1
  SendMessage $mui.Button.Cancel ${WM_SETFONT} $VoxelightBodyFont 1
FunctionEnd

Function .onGUIEnd
  ${If} $VoxelightArtHandle P<> 0
    ${NSD_FreeImage} $VoxelightArtHandle
    StrCpy $VoxelightArtHandle 0
  ${EndIf}
  ${If} $VoxelightDisplayFont P<> 0
    System::Call 'gdi32::DeleteObject(p $VoxelightDisplayFont)'
  ${EndIf}
  ${If} $VoxelightSmallFont P<> 0
    System::Call 'gdi32::DeleteObject(p $VoxelightSmallFont)'
  ${EndIf}
  ${If} $VoxelightSemiboldFont P<> 0
    System::Call 'gdi32::DeleteObject(p $VoxelightSemiboldFont)'
  ${EndIf}
  ${If} $VoxelightBodyFont P<> 0
    System::Call 'gdi32::DeleteObject(p $VoxelightBodyFont)'
  ${EndIf}
  ${If} $VoxelightInheritedHeaderFont P<> 0
    System::Call 'gdi32::DeleteObject(p $VoxelightInheritedHeaderFont)'
  ${EndIf}
  ${If} $VoxelightSemiboldFontLoaded <> 0
    System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\MiSans-Semibold.ttf", i ${VOXELIGHT_FR_PRIVATE}, p 0)'
  ${EndIf}
  ${If} $VoxelightRegularFontLoaded <> 0
    System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\MiSans-Regular.ttf", i ${VOXELIGHT_FR_PRIVATE}, p 0)'
  ${EndIf}
FunctionEnd

; Built-in MUI pages expose their controls as direct children of #32770.
Function VoxelightApplyDialogFonts
  Push $R5
  System::Call 'user32::GetWindow(pR4,i5)p.R5'
  voxelight_font_loop:
    ${If} $R5 P= 0
      Goto voxelight_font_done
    ${EndIf}
    SendMessage $R5 ${WM_SETFONT} $VoxelightBodyFont 1
    System::Call 'user32::GetWindow(pR5,i2)p.R5'
    Goto voxelight_font_loop
  voxelight_font_done:
  Pop $R5
FunctionEnd

Function VoxelightStyleStandardPage
  FindWindow $R4 "#32770" "" $HWNDPARENT
  ${If} $R4 P<> 0
    Call VoxelightApplyDialogFonts
  ${EndIf}
FunctionEnd

Function PageWelcome
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  nsDialogs::Create 1044
  Pop $R4
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  SetCtlColors $R4 292C2E F5F3EE

  ${NSD_CreateBitmap} 198u 0 117u 193u ""
  Pop $VoxelightImage
  ${NSD_SetStretchedImage} $VoxelightImage "$PLUGINSDIR\voxelight-scene.bmp" $VoxelightArtHandle

  ${NSD_CreateLabel} 22u 16u 160u 16u "Voxelight"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightSemiboldFont 1
  SetCtlColors $R1 292C2E F5F3EE

  ${NSD_CreateLabel} 22u 37u 24u 2u ""
  Pop $R1
  SetCtlColors $R1 "" A9BD63

  ${NSD_CreateLabel} 22u 48u 164u 52u "$(welcomeTitle)"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightDisplayFont 1
  SetCtlColors $R1 292C2E F5F3EE

  ${NSD_CreateLabel} 22u 108u 162u 36u "$(welcomeDescription)"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightBodyFont 1
  SetCtlColors $R1 5F6468 F5F3EE

  ${NSD_CreateLabel} 22u 153u 164u 22u "$(currentUserNotice)"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightSmallFont 1
  SetCtlColors $R1 5F6468 F5F3EE

  ${NSD_CreateLabel} 22u 179u 164u 10u "$(installerSteps)"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightSmallFont 1
  SetCtlColors $R1 5F6468 F5F3EE

  Call muiPageLoadFullWindow
  ${NSD_SetFocus} $mui.Button.Next
  nsDialogs::Show
  Call muiPageUnloadFullWindow
  ${NSD_FreeImage} $VoxelightArtHandle
  StrCpy $VoxelightArtHandle 0
FunctionEnd

Function PageFinish
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  nsDialogs::Create 1044
  Pop $R4
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  SetCtlColors $R4 292C2E F5F3EE

  ${NSD_CreateBitmap} 198u 0 117u 193u ""
  Pop $VoxelightImage
  ${NSD_SetStretchedImage} $VoxelightImage "$PLUGINSDIR\voxelight-scene.bmp" $VoxelightArtHandle

  ${NSD_CreateLabel} 22u 16u 160u 16u "Voxelight"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightSemiboldFont 1
  SetCtlColors $R1 292C2E F5F3EE

  ${NSD_CreateLabel} 22u 37u 24u 2u ""
  Pop $R1
  SetCtlColors $R1 "" A9BD63

  ${NSD_CreateLabel} 22u 48u 164u 44u "$(finishTitle)"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightDisplayFont 1
  SetCtlColors $R1 292C2E F5F3EE

  ${NSD_CreateLabel} 22u 101u 162u 32u "$(finishDescription)"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightBodyFont 1
  SetCtlColors $R1 5F6468 F5F3EE

  ${NSD_CreateCheckBox} 22u 140u 164u 18u "$(launchNow)"
  Pop $VoxelightRun
  SendMessage $VoxelightRun ${WM_SETFONT} $VoxelightBodyFont 1
  SetCtlColors $VoxelightRun 292C2E F5F3EE

  ${NSD_CreateLabel} 22u 169u 164u 22u "$(dataRetention)"
  Pop $R1
  SendMessage $R1 ${WM_SETFONT} $VoxelightSmallFont 1
  SetCtlColors $R1 5F6468 F5F3EE

  GetDlgItem $R1 $HWNDPARENT 1
  SendMessage $R1 ${WM_SETTEXT} 0 "STR:$(^CloseBtn)"
  GetDlgItem $R1 $HWNDPARENT 3
  EnableWindow $R1 0
  GetDlgItem $R1 $HWNDPARENT 2
  EnableWindow $R1 0
  Call muiPageLoadFullWindow
  ${NSD_SetFocus} $VoxelightRun
  nsDialogs::Show
  Call muiPageUnloadFullWindow
  ${NSD_FreeImage} $VoxelightArtHandle
  StrCpy $VoxelightArtHandle 0
FunctionEnd

Function PageFinishLeave
  ${NSD_GetState} $VoxelightRun $R1
  ${If} $R1 = ${BST_CHECKED}
    Call RunMainBinary
  ${EndIf}
FunctionEnd

Function PageOptions
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $R4
  SetCtlColors $R4 292C2E F5F3EE
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  !insertmacro MUI_HEADER_TEXT "$(optionsTitle)" "$(optionsDescription)"

  ${NSD_CreateLabel} 0 4u 100% 30u "$(dataRetention)"
  Pop $R1
  SetCtlColors $R1 5F6468 F5F3EE

  ${NSD_CreateCheckBox} 0 52u 100% 18u "$(desktopShortcut)"
  Pop $DesktopShortcutCheckboxHandle
  SetCtlColors $DesktopShortcutCheckboxHandle 292C2E F5F3EE
  SendMessage $DesktopShortcutCheckboxHandle ${BM_SETCHECK} $DesktopShortcutChecked 0

  ${NSD_CreateCheckBox} 0 79u 100% 18u "$(startMenuShortcut)"
  Pop $StartMenuShortcutCheckboxHandle
  SetCtlColors $StartMenuShortcutCheckboxHandle 292C2E F5F3EE
  SendMessage $StartMenuShortcutCheckboxHandle ${BM_SETCHECK} $StartMenuShortcutChecked 0

  ${NSD_CreateLabel} 0 124u 100% 28u "$(currentUserNotice)"
  Pop $R2
  SetCtlColors $R2 5F6468 F5F3EE

  Call VoxelightApplyDialogFonts
  ${NSD_SetFocus} $DesktopShortcutCheckboxHandle
  nsDialogs::Show
FunctionEnd

Function PageOptionsLeave
  SendMessage $DesktopShortcutCheckboxHandle ${BM_GETCHECK} 0 0 $DesktopShortcutChecked
  SendMessage $StartMenuShortcutCheckboxHandle ${BM_GETCHECK} 0 0 $StartMenuShortcutChecked

  StrCpy $NoDesktopShortcutMode 0
  StrCpy $NoShortcutMode 0
  ${If} $DesktopShortcutChecked = 0
    StrCpy $NoDesktopShortcutMode 1
  ${EndIf}
  ${If} $StartMenuShortcutChecked = 0
    StrCpy $NoShortcutMode 1
  ${EndIf}
FunctionEnd
