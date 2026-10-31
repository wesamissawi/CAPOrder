; Tabs until focus lands on target1 (or target2). Returns false when it gives
; up — a caller about to type must stop, or the typing lands in the wrong field.
tabTo(target1, wait, target2:= "DonkeyKongCountry", shift := false, tabCountMax := 31)
{
    tabCount := 0  ; Initialize tab counter
    tabKey := shift ? "+{Tab}" : "{Tab}"  ; Shift+Tab when tabbing backward
    WinGet, hwnd, ID, A
    blankSince := 0

    Loop
    {
        ; Let Sage catch up on the tabs already sent, otherwise the focus read
        ; is stale and we tab straight past the target.
        WaitSageIdle(3000, hwnd)
        ControlGetFocus, focusedControl, A

        ; Blank means Sage was too busy to report focus, not that we've
        ; arrived (an empty target2 used to match it). Look again.
        if (focusedControl = "") {
            if (!blankSince)
                blankSince := A_TickCount
            if (A_TickCount - blankSince > 15000) {
                Log("tabTo: couldn't read focus for 15s looking for " . target1)
                return false
            }
            Sleep, 100
            continue
        }
        blankSince := 0

        ; Check if the focused control matches either of the targets
        If (focusedControl = target1 || (target2 != "" && focusedControl = target2))
            Break

        ; Stop after the specified number of tabs
        If (tabCount >= tabCountMax)
        {
            Log("tabTo: " . tabCountMax . " tabs without reaching " . target1 . " (stuck on " . focusedControl . ")")
            return false
        }

        ; Send the tab key press (forward or backward depending on the shift value)
        Send, %tabKey%
        tabCount++
        Sleep, wait ; Adjust the sleep duration as needed
    }
    Sleep, wait ; Final sleep for stability
    return true
}



; --- Waiting on Sage -------------------------------------------------------
; Sage gets slower the longer it stays open, so a fixed Sleep that is plenty on
; a fresh start falls short by the end of the day and keystrokes land in the
; wrong field. These wait on Sage itself.

; True once Sage's UI thread answers a no-op message promptly twice in a row
; (it can't while it's busy with a lookup) and the cursor isn't busy.
; False if it's still busy after maxMs.
WaitSageIdle(maxMs := 15000, hwnd := "") {
    if (hwnd = "")
        WinGet, hwnd, ID, A
    if (!hwnd)
        return false
    start := A_TickCount
    calm := 0
    Loop {
        ; WM_NULL, SMTO_ABORTIFHUNG, 100ms to answer
        answered := DllCall("SendMessageTimeout", "Ptr", hwnd, "UInt", 0, "Ptr", 0, "Ptr", 0
            , "UInt", 0x2, "UInt", 100, "Ptr*", res)
        if (answered && A_Cursor != "Wait" && A_Cursor != "AppStarting")
            calm++
        else
            calm := 0
        if (calm >= 2)
            return true
        if (A_TickCount - start > maxMs)
            return false
        Sleep, 30
    }
}

; WaitSageIdle, plus the window's text has stopped changing for quietMs: after
; a vendor or item lookup the form redraws once the thread frees up.
WaitSageSettled(maxMs := 20000, hwnd := "", quietMs := 500) {
    if (hwnd = "")
        WinGet, hwnd, ID, A
    start := A_TickCount
    last := ""
    first := true
    Loop {
        remaining := maxMs - (A_TickCount - start)
        if (remaining <= 0 || !WaitSageIdle(remaining, hwnd))
            return false
        WinGetText, txt, ahk_id %hwnd%
        if (first || txt !== last) {
            last := txt, stableSince := A_TickCount, first := false
        } else if (A_TickCount - stableSince >= quietMs) {
            return true
        }
        Sleep, 100
    }
}

; One log line per run so failures can be matched against how long Sage has
; been open and how many handles it holds (WinForms apps leak GDI/USER objects
; and Windows caps a process at 10,000 of each).
LogSageHealth(hwnd) {
    WinGet, pid, PID, ahk_id %hwnd%
    ; PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
    h := DllCall("OpenProcess", "UInt", 0x1010, "Int", 0, "UInt", pid, "Ptr")
    if (!h) {
        Log("SAGE_HEALTH pid=" . pid . " (couldn't open process)")
        return
    }
    gdi  := DllCall("GetGuiResources", "Ptr", h, "UInt", 0)
    user := DllCall("GetGuiResources", "Ptr", h, "UInt", 1)

    ; PROCESS_MEMORY_COUNTERS: two DWORDs then nine SIZE_Ts
    size := 8 + 9 * A_PtrSize
    VarSetCapacity(pmc, size, 0)
    NumPut(size, pmc, 0, "UInt")
    ws := priv := ""
    if DllCall("K32GetProcessMemoryInfo", "Ptr", h, "Ptr", &pmc, "UInt", size) {
        ws   := Round(NumGet(pmc, 8 + 1 * A_PtrSize, "UPtr") / 1048576)  ; WorkingSetSize
        priv := Round(NumGet(pmc, 8 + 6 * A_PtrSize, "UPtr") / 1048576)  ; PagefileUsage
    }

    hours := ""
    VarSetCapacity(created, 8, 0), VarSetCapacity(unused, 8, 0)
    if DllCall("GetProcessTimes", "Ptr", h, "Ptr", &created, "Ptr", &unused, "Ptr", &unused, "Ptr", &unused) {
        DllCall("GetSystemTimeAsFileTime", "Int64*", now)
        hours := Round((now - NumGet(created, 0, "Int64")) / 36000000000, 1)  ; 100ns ticks
    }
    DllCall("CloseHandle", "Ptr", h)

    Log("SAGE_HEALTH pid=" . pid . " gdi=" . gdi . " user=" . user . " workingSetMB=" . ws
        . " privateMB=" . priv . " openHours=" . hours)
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
        MsgBox, 16, Txn Error, Transaction confirmation window not found within %timeout%s.
        return ""  ; timed out
    }

    ; Get its handle and text
    WinGet, hwnd, ID, %title%
    WinGetText, allText, ahk_id %hwnd%
    ; Normalize whitespace
    allText := RegExReplace(allText, "\R+", "`n")

    ;MsgBox, 64, Txn Debug, Raw text:`n%allText%

    ; New format: "2 Journal Entries: Jxxxx to Jyyyy"
   if RegExMatch(allText, "i)Journal\s*Entries:\s*([A-Z0-9-]+)\s*to\s*([A-Z0-9-]+)", m2) {
        rangeText := m21 . " to " . m22
        ;MsgBox, 64, Txn Debug1, Parsed range:`n%rangeText%
        return rangeText
    }
    ; Variant: "2 Transaction Numbers: Jxxxx to Jyyyy"
   if RegExMatch(allText, "i)Transaction\s*Numbers?:\s*([A-Z0-9-]+)\s*to\s*([A-Z0-9-]+)", m3) {
        rangeText := m31 . " to " . m32
        return rangeText
    }

    ; Legacy: "Transaction Number: J4191."
    if RegExMatch(allText, "i)Transaction\s*Number:\s*([A-Z0-9\-]+)", m) {
        single := m1
        ;MsgBox, 64, Txn Debug2, Parsed single:`n%single%
        return m1
    }
    MsgBox, 48, Txn Debug, No journal entry found.`nRaw text:`n%allText%
    return ""  ; not found
}



GetSageTotal(title, timeout := 15) {
    ; Wait for the window to appear
    WinWait, %title%,, %timeout%
    if (ErrorLevel)
        return ""  ; timed out

    ; Get its handle and aggregate visible text
    WinGet, hwnd, ID, %title%
    prevHidden := A_DetectHiddenText
    DetectHiddenText, Off
    WinGetText, allText, ahk_id %hwnd%
    DetectHiddenText, %prevHidden%

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
        obj.sage_reference_synced := obj.HasKey("sage_reference") ? obj.sage_reference : obj.reference
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

    ; Best-effort backup, written from the copy already in memory. FileCopy
    ; would reopen the live file denying delete-sharing, which blocks the
    ; Electron app on another machine from replacing it (EPERM on its rename).
    fb := FileOpen(bak, "w", "UTF-8-RAW")
    if IsObject(fb) {
        fb.Write(jsonText), fb.Close()
    }

    f := FileOpen(tmp, "w", "UTF-8-RAW")
    if !IsObject(f) {
        MsgBox, 16, Error, Couldn't open temp file:`n%tmp%
        return false
    }
    f.Write(newJson), f.Close()

    ; FileMove (rename) replaces the target atomically — FileCopy truncated the
    ; destination first, letting concurrent readers see a partial file.
    ; Retry: another machine or a scanner can briefly hold the destination open
    ; without delete-sharing, which denies the replace for a few milliseconds.
    moved := false
    Loop, 5 {
        FileMove, %tmp%, %jsonPath%, 1  ; 1 = overwrite
        if (!ErrorLevel) {
            moved := true
            break
        }
        Sleep, % 40 * A_Index
    }
    if (!moved) {
        MsgBox, 16, Error, Couldn't move temp over original:`n%jsonPath%
        FileDelete, %tmp%
        return false
    }
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


; Centralized error reporting + false return. The box closes itself after 20s
; so an unattended run (Ghost Mode) isn't held open until the AHK timeout.
ReturnFalse(msg) {
    Log("ERROR: " . msg)
    MsgBox, 16, Error, %msg%, 20
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
