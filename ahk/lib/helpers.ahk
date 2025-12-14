tabTo(target1, wait, target2:= "DonkeyKongCountry", shift := false, tabCountMax := 31)
{
    tabCount := 0  ; Initialize tab counter
    tabKey := "{Tab}"  ; Default to forward tab

    ; If shift is true, use Shift+Tab for backward tabbing
    if (shift)
    {
        tabKey := "+{Tab}"
    }

    Loop
    {
        ControlGetFocus, focusedControl, A

        ; Check if the focused control matches either of the targets
        If (focusedControl = target1 or focusedControl = target2)
        {
            ; Desired control found, exit the loop
            Break
        }

        ; Send the tab key press (forward or backward depending on the shift value)
        Send, %tabKey%

        tabCount++  ; Increment tab counter

        ; Stop after the specified number of tabs
        If (tabCount >= tabCountMax)
        {
            MsgBox, %tabCountMax% tabs reached, stopping.
            Break  ; Exit the loop after tabbing the max number of times
        }

        Sleep, wait ; Adjust the sleep duration as needed
    }
    Sleep, wait ; Final sleep for stability
}



SendTab(n, wait){
	Sleep wait
	Loop, % n{

		Send {Tab}
		Sleep wait
	}
	return
}




CopytoClipBoard(a){
	clipboard = ; start empty to allow Clipwait to detect when the text has arrived
	Sleep, 50
	Send ^c
	ClipWait  ; Wait for the clipboard to contain text
	Sleep 50
	StringReplace, clipboard, clipboard, `r`n, , All
	Sleep, 50
	return %clipboard%
}




ReadFileContent(filePath) {
    FileRead, fileContent, % filePath
    return fileContent
}



; GetTextByClassRe(WinTitle, ClassRegex, TextRegex := "", Nth := 1)
; - Scans all controls in WinTitle
; - Picks controls whose ClassNN matches ClassRegex
; - Reads each control’s text (ControlGetText)
; - If TextRegex is non-empty, requires the text to match it
; - Returns the Nth match’s text (default 1st), or "" if none
GetTextByClassRe(WinTitle, ClassRegex, TextRegex := "", Nth := 1) {
    WinGet, ctrlList, ControlList, %WinTitle%
    if (!ctrlList)
        return ""

    count := 0
    Loop, Parse, ctrlList, `n, `r
    {
        ctrl := A_LoopField
        if !RegExMatch(ctrl, ClassRegex)
            continue

        ; Try normal control text first
        ControlGetText, txt, %ctrl%, %WinTitle%

        ; Optional fallback via Acc.ahk if text is blank
        if (txt = "") {
            ; ;;; UNCOMMENT the next 6 lines if you include Acc.ahk (see notes below)
            ; ControlGet, hCtl, Hwnd,, %ctrl%, %WinTitle%
            ; try {
            ;     acc := Acc_Get("Object", "", "ahk_id " hCtl)
            ;     if IsObject(acc)
            ;         txt := (acc.accValue(0) != "" ? acc.accValue(0) : acc.accName(0))
            ; }
        }

        txt := Trim(RegExReplace(txt, "\R+", " ")) ; normalize

        if (TextRegex != "" && !RegExMatch(txt, TextRegex))
            continue

        count++
        if (count = Nth)
            return txt
    }
    return ""
}






GetSageTxnNumber(timeout := 15) {
    title := "Sage 50 - Transaction Confirmation"

    ; Wait for the window to appear
    WinWait, %title%,, %timeout%
    if (ErrorLevel) {
        return ""  ; timed out
    }

    ; Get its handle and text
    WinGet, hwnd, ID, %title%
    WinGetText, allText, ahk_id %hwnd%
    ; Optional: normalize whitespace a bit
    allText := RegExReplace(allText, "\R+", "`n")

    ; Parse: Transaction Number: J4191.
    ; capture letters/digits/dashes, ignore trailing period
    if RegExMatch(allText, "i)Transaction\s*Number:\s*([A-Z0-9\-]+)", m) {
        return m1
    }
    return ""  ; not found
}



GetSageTotal(title, timeout := 15) {
    ; Wait for the window to appear
    WinWait, %title%,, %timeout%
    if (ErrorLevel)
        return ""  ; timed out

    ; Get its handle and aggregate visible text
    WinGet, hwnd, ID, %title%
    DetectHiddenText, Off
    WinGetText, allText, ahk_id %hwnd%

    ; Normalize newlines and keep only non-empty lines, preserving order
    allText := StrReplace(allText, "`r")  ; CRLF -> LF
    lines := []
    Loop, Parse, allText, `n
    {
        line := Trim(A_LoopField)
        if (line != "")
            lines.Push(line)
    }

    ; Find "&Process" and return the line after it
    Loop % lines.MaxIndex()
    {
        if (lines[A_Index] = "&Process") {
            nextLine := (A_Index < lines.MaxIndex()) ? lines[A_Index + 1] : ""
            if (nextLine = "")
                return ""

            ; Extract a number like 24.92 (optionally with currency/spaces)
            if RegExMatch(nextLine, "i)\$?\s*([0-9]+(?:\.[0-9]+)?)", m)
                return m1
            return nextLine  ; fallback: return raw line
        }
    }

    return ""  ; not found
}


UpdateOrderJournal(ref, journalEntry, jsonPath := "") {
    ; Build default path to the Electron orders file under AppData
    if (jsonPath = "") {
        jsonPath := A_AppData . "\my-electron-app\orders.json"

        ; Fallback to legacy relative location if the AppData file is missing
        if !FileExist(jsonPath)
            jsonPath := A_ScriptDir . "\..\Orders\allOrders.json"
    }

    if !FileExist(jsonPath) {
        MsgBox, 16, Error, Can't find JSON file:`n%jsonPath%
        return false
    }

    ; Read JSON
    FileRead, jsonText, %jsonPath%
    if (ErrorLevel) {
        MsgBox, 16, Error, Couldn't read:`n%jsonPath%
        return false
    }

    ; Parse
    json   := new JSON()
    orders := json.Load(jsonText)   ; expect an array of objects
    if !IsObject(orders) {
        MsgBox, 16, Error, JSON parse failed (not an array/object?).
        return false
    }

    ; Normalize reference for matching
    refKey := ToUpper(Trim("" . ref))

    ; Find by reference (case-insensitive, matches sage_reference or reference)
    found := false
    for i, obj in orders {
        cand := ""
        if (obj.HasKey("sage_reference"))
            cand := obj.sage_reference
        if (cand = "" && obj.HasKey("reference"))
            cand := obj.reference
        if (cand = "" && obj.HasKey("__row"))
            cand := obj.__row

        candKey := ToUpper(Trim("" . cand))
        if (candKey = "" || candKey != refKey)
            continue

        obj.journalEntry       := journalEntry     ; camelCase (matches your sample)
        obj.journal_entry      := journalEntry     ; optional: snake_case too
        obj.enteredInSage      := 1
        obj.invoiceSageUpdate  := 1
        obj.sage_trigger       := false
        obj.sage_processed_at  := A_Now
        found := true
        break
    }

    if (!found) {
        MsgBox, 48, Not found, No order with reference "%ref%" found.
        return false
    }

    ; Serialize (pretty)
    newJson := json.Dump(orders, 4)

    ; Safe write via temp file, UTF-8 without BOM (keep original if copy fails)
    tmp := jsonPath . ".tmp"
    bak := jsonPath . ".bak"
    FileCopy, %jsonPath%, %bak%, 1  ; best-effort backup

    f := FileOpen(tmp, "w", "UTF-8-RAW")
    if !IsObject(f) {
        MsgBox, 16, Error, Couldn't open temp file:`n%tmp%
        return false
    }
    f.Write(newJson), f.Close()

    FileCopy, %tmp%, %jsonPath%, 1  ; overwrite only if copy succeeds
    if (ErrorLevel) {
        MsgBox, 16, Error, Couldn't copy temp over original:`n%jsonPath%
        return false
    }

    FileDelete, %tmp%
    return true
}


; --- Logging ---------------------------------------------------------------
global __AHK_LOG := A_AppData . "\my-electron-app\ahk_sage.log"

Log(msg) {
    ; stdout (captured when spawned) + file (for manual inspection)
    FileAppend, %msg%`n, *
    try {
        ; ensure directory exists
        SplitPath, __AHK_LOG, , __logDir
        if (!FileExist(__logDir))
            FileCreateDir, %__logDir%
        FileAppend, %msg%`n, %__AHK_LOG%
    } catch e {
        ; ignore file write errors
    }
}


; Centralized error reporting + false return.
ReturnFalse(msg) {
    Log("ERROR: " . msg)
    MsgBox, 16, Error, %msg%
    return false
}

; Optional: debug message (flip to 1 if you want popups)
DEBUG := 0
Dbg(msg) {
    global DEBUG
    if (DEBUG)
        MsgBox, 64, Debug, %msg%
    Log("DEBUG: " . msg)
}

; Uppercase wrapper (AHK v1 compatible)
ToUpper(str) {
    StringUpper, out, str, T
    return out
}
