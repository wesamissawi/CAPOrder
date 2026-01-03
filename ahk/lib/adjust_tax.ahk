; adjust_tax.ahk
; Utility to adjust Sage GST/HST field by a delta (positive or negative).
; Expects supporting helpers (tabTo, SendTab) to be available in the caller.

AdjustSageTax(delta) {
    if (delta = "" || delta = 0) {
        MsgBox, 16, Adjust Tax, Delta is blank or zero. Nothing to adjust.
        return false
    }

    ; Focus Sage Purchases window (handle different title variants, including Adjusting Invoice)
    if WinExist("Purchases - Creating an Invoice") {
        WinActivate
        WinMaximize
    }
    if WinExist("Purchases Journal - Creating an Invoice") {
        WinActivate
        WinMaximize
    }
    if WinExist("Purchases - Adjusting Invoice") {
        WinActivate
        WinMaximize
    }

    WinWaitActive, Purchases - Creating an Invoice, , 3
    if (ErrorLevel) {
        WinWaitActive, Purchases Journal - Creating an Invoice, , 3
    }
    if (ErrorLevel) {
        WinWaitActive, Purchases - Adjusting Invoice, , 3
    }

    if (ErrorLevel) {
        ; Fallback: regex match any Purchases window that mentions Invoice/Adjusting
        WinGet, winList, List, Purchases
        caught := false
        Loop, %winList%
        {
            thisHwnd := winList%A_Index%
            WinGetTitle, t, ahk_id %thisHwnd%
            if RegExMatch(t, "i)^Purchases.*Invoice") {
                WinActivate, ahk_id %thisHwnd%
                WinWaitActive, ahk_id %thisHwnd%, , 2
                if (!ErrorLevel) {
                    caught := true
                    break
                }
            }
        }
        if (!caught) {
            MsgBox, 16, Adjust Tax, Could not activate Sage Purchases window.
            return false
        }
    }

    Sleep, 200

    ; Land on Edit1 as a known anchor
    tabTo("Edit1", 150)
    Sleep, 100

    ; Navigate back to the tax box (GST/HST)
    Loop, 5 {
        Send, +{Tab}
        Sleep, 100
    }

    Send, {Enter}
    Sleep, 200

    Loop, 2 {
        Send, +{Tab}
        Sleep, 100
    }

    ; Capture current value (highlighted) for potential logging/debugging
    currentRaw := CopytoClipBoard("")
    if (currentRaw = "") {
        MsgBox, 16, Adjust Tax, Failed to read current tax value from Sage.
        return false
    }

    currentClean := RegExReplace(currentRaw, "[^0-9\.\-]", "")
    if (currentClean = "") {
        MsgBox, 16, Adjust Tax, Could not parse current tax value: "%currentRaw%".
        return false
    }
    currentNum := currentClean + 0.0
    if (!currentNum && currentClean != "0" && currentClean != "0.0") {
        MsgBox, 16, Adjust Tax, Invalid tax number: "%currentRaw%".
        return false
    }

    newTax := currentNum + delta
    deltaStr := Format("{:.2f}", newTax)

    ; Overwrite with the adjusted tax value
    Send, %deltaStr%
    Sleep, 100
    Send, {Tab}
    Sleep, 150
    Send, {Enter}
    Sleep, 200

    return true
}
