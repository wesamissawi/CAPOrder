#NoEnv
#SingleInstance, Force
SetTitleMatchMode, 2
SendMode, Input
SetKeyDelay, 25, 25

; ===== Which window to activate (both titles you mentioned) =====
titles := ["Purchases - Creating an Invoice", "Purchases Journal - Creating an Invoice"]
winFound := false
for i, t in titles {
    if WinExist(t) {
        WinActivate, %t%
        WinWaitActive, %t%,, 3
        winFound := true
        break
    }
}
if (!winFound) {
    MsgBox, 48, Not Found, Couldn't find a Purchases window.`nMake sure it's visible and unlocked.
    ExitApp
}

; ===== UIA factory (robust for AHK v1) =====
UIA_Factory() {
    static uia
    if (IsObject(uia))
        return uia

    prog1 := "UIAutomationClient.CUIAutomation"          ; v7
    prog8 := "UIAutomationClient.CUIAutomation8"         ; v8+
    cls1  := "{FF48DBA4-60EF-4201-AA87-54103EEF594E}"    ; CLSID_CUIAutomation
    cls8  := "{E22AD333-B25F-460C-83D0-0581107395C9}"    ; CLSID_CUIAutomation8

    try uia := ComObjCreate(prog1)
    catch
        try uia := ComObjCreate(cls1)
        catch
            try uia := ComObjCreate(prog8)
            catch
                uia := ComObjCreate(cls8)

    return uia
}

; ===== UIA constants =====
UIA_AutomationIdPropertyId := 30011
UIA_NamePropertyId         := 30005
UIA_ControlTypePropertyId  := 30003

; ===== Helper: get focused element props =====
UIA_GetFocusedProps(ByRef id:="", ByRef name:="", ByRef ctrlType:="") {
    id := name := ctrlType := ""
    uia := UIA_Factory()
    try el := uia.GetFocusedElement()
    if (!el)
        return false
    ; Property reads are wrapped in try to avoid exceptions on odd controls
    try id := el.GetCurrentPropertyValue(UIA_AutomationIdPropertyId)
    try name := el.GetCurrentPropertyValue(UIA_NamePropertyId)
    try ctrlType := el.GetCurrentPropertyValue(UIA_ControlTypePropertyId)
    return true
}

; ===== Tab 40 times and MsgBox the AutomationId each time =====
TabsToSend := 40
Loop, %TabsToSend%
{
    Send, {Tab}
    Sleep, 150
    if UIA_GetFocusedProps(id, name, ctype) {
        if (id = "" || id = 0)
            id := "(no AutomationId)"
        MsgBox, 64, Tab #%A_Index%, AutomationId: %id%`nName: %name%`nControlTypeId: %ctype%
    } else {
        MsgBox, 48, Tab #%A_Index%, Could not read UIA focused element.`n(Try running AHK as Administrator if Sage is elevated.)
    }
}

ExitApp
