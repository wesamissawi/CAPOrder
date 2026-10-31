#NoEnv
#SingleInstance, Force
SetBatchLines, -1

SendMode, Input
SetWorkingDir, %A_ScriptDir%


SetTitleMatchMode, 2           ; allow partial title matches
DetectHiddenText, On           ; sometimes helps WinGetText
SetWinDelay, 0

#Include %A_ScriptDir%\lib\JSON.ahk
#Include %A_ScriptDir%\lib\capRules\rules.ahk
#Include %A_ScriptDir%\lib\helpers.ahk
#Include %A_ScriptDir%\lib\adjust_tax.ahk


; --- Helpers ---------------------------------------------------------------
GetOrderSortKey(orderObj) {
    if (!IsObject(orderObj))
        return "99999999999999"
    dt := ""
    if (orderObj.HasKey("orderDate"))
        dt := orderObj.orderDate
    if (dt = "" && orderObj.HasKey("orderDateRaw"))
        dt := orderObj.orderDateRaw
    if (dt = "" && orderObj.HasKey("sageDate"))
        dt := orderObj.sageDate  ; already ddmmyy

    if (dt != "") {
        cleaned := RegExReplace(dt, "[^0-9]", "")
        if (StrLen(cleaned) >= 8) {
            ; Take up to YYYYMMDDHHMMSS if present; pads comparison lexically.
            return SubStr(cleaned, 1, 14)
        }
    }
    return "99999999999999"
}

SelectOrderFromJson(data, orderRef := "") {
    if (!IsObject(data))
        return ""

    refKey := ToUpper(Trim("" . orderRef))

    ; Array: try ref match, then first sage_trigger, then first entry
    if (data.MaxIndex()) {
        for i, obj in data {
            if !IsObject(obj)
                continue
            cand := obj.HasKey("sage_reference") ? obj.sage_reference : obj.reference
            candKey := ToUpper(Trim("" . cand))
            if (refKey != "" && candKey = refKey)
                return obj
        }

        ; Oldest sage_trigger first (by orderDate/orderDateRaw)
        bestObj := ""
        bestKey := ""
        for i, obj in data {
            if !IsObject(obj)
                continue
            if (obj.HasKey("sage_trigger") && obj.sage_trigger) {
                key := GetOrderSortKey(obj)
                if (bestKey = "" || key < bestKey) {
                    bestKey := key
                    bestObj := obj
                }
            }
        }
        if (bestObj)
            return bestObj

        for i, obj in data {
            if !IsObject(obj)
                continue
            if (obj.HasKey("sage_trigger") && obj.sage_trigger) {
                return obj
            }
        }
        return data[1]
    }

    ; Single object
    return data
}

NormalizeSageDate(orderObj) {
    date := ""
    if (IsObject(orderObj)) {
        if (orderObj.HasKey("sageDate"))
            date := orderObj.sageDate
        if (date = "" && orderObj.HasKey("date"))
            date := orderObj.date
        if (date = "" && orderObj.HasKey("orderDate")) {
            try {
                FormatTime, parsed, % orderObj.orderDate, ddMMyy
                if (parsed != "")
                    date := parsed
            }
        }
    }
    if (date = "")
        date := A_DD . A_MM . SubStr(A_YYYY, 3)
    return date
}

PurchasesWindowActive() {
    return WinActive("Purchases - Creating an Invoice") || WinActive("Purchases Journal - Creating an Invoice")
}

; Keystrokes go to whatever window is active. If a popup or another app took
; focus, log what took over so the caller can stop before typing into it.
EnsurePurchasesActive(where) {
    if PurchasesWindowActive()
        return true
    WinGetTitle, t, A
    WinGetClass, c, A
    WinGetText, txt, A
    Log("Purchases window lost focus " . where . ": active='" . t . "' class=" . c
        . " text=" . SubStr(RegExReplace(txt, "\R+", " | "), 1, 300))
    return false
}

; Text of whichever control has focus. The ClassNNs are dynamic, so read
; through focus rather than by name.
FocusedText(hwnd) {
    ControlGetFocus, ctl, ahk_id %hwnd%
    if (ctl = "")
        return ""
    ControlGetText, txt, %ctl%, ahk_id %hwnd%
    return Trim(txt)
}

; After Tab-ing off an item code: a new part opens "Select Inventory/Service",
; an existing one moves focus off the item column. Polls for either rather
; than reading once after a fixed Sleep. Returns "new", "existing" or "".
WaitItemLookup(hwnd, oldX, timeoutMs := 20000) {
    start := A_TickCount
    Loop {
        if WinExist("Select Inventory/Service")
            return "new"
        ControlGetFocus, ctl, ahk_id %hwnd%
        if (ctl != "") {
            ControlGetPos, x,,,, %ctl%, ahk_id %hwnd%
            if (x != "" && x != oldX) {
                ; The popup may have opened between the two reads.
                Sleep, 150
                return WinExist("Select Inventory/Service") ? "new" : "existing"
            }
        }
        if (A_TickCount - start > timeoutMs)
            return ""
        Sleep, 100
    }
}


; --- Main ------------------------------------------------------------------

makePurchaseFromJSON(pathToFile, warehouse := "", orderRef := "", updateJsonPath := "") {
    ; Focus Sage Purchases window (either title variant)
    if WinExist("Purchases - Creating an Invoice") {
        WinActivate
        WinMaximize
    }
    if WinExist("Purchases Journal - Creating an Invoice") {
        WinActivate
        WinMaximize
    }

    Sleep, 200

    ; Wait for either of the two windows to be active
    WinWaitActive, Purchases - Creating an Invoice, , 5
    if (ErrorLevel) {
        WinWaitActive, Purchases Journal - Creating an Invoice, , 5
        if (ErrorLevel)
            return ReturnFalse("Took longer than 10 seconds to load Purchases window (either variant).")
    }

    Sleep, 50
    WinGet, sageHwnd, ID, A

    jsonFilePath := pathToFile
    if !FileExist(jsonFilePath)
        return ReturnFalse("File not found:`n" . jsonFilePath)

    jsonContent := ""
    try {
        jsonContent := ReadFileContent(jsonFilePath)
        ; strip BOM if present
        if (SubStr(jsonContent, 1, 1) = Chr(0xFEFF))
            jsonContent := SubStr(jsonContent, 2)
        jsonContent := Trim(jsonContent, "`r`n `t")
    } catch e {
        Log("File read exception: " . e.Message)
        return ReturnFalse("File read failed:`n" . jsonFilePath)
    }
    if (!jsonContent)
        return ReturnFalse("No JSON content in:`n" . jsonFilePath . "`nTry running the script again.")

    parsedData := ""
    try {
        json := new JSON()
        rawData := json.Load(jsonContent)
        parsedData := SelectOrderFromJson(rawData, orderRef)
        if (!IsObject(rawData))
            Log("Parse produced non-object. value preview=" . SubStr("" . rawData, 1, 80))
    } catch e {
        msg := ""
        try msg := e.Message
        extra := ""
        try extra := e.Extra
        what := ""
        try what := e.What
        Log("Parse exception: " . msg . " what=" . what . " extra=" . extra)
    }
    if (!IsObject(parsedData)) {
        Log("Parse failed. Content len=" . StrLen(jsonContent) . " path=" . jsonFilePath)
        Log("Content head: " . SubStr(jsonContent, 1, 200))
        Log("Content tail: " . SubStr(jsonContent, StrLen(jsonContent) - 200))
        return ReturnFalse("JSON parsing failed.")
    }

    reference := ""
    if (parsedData.HasKey("sage_reference"))
        reference := parsedData.sage_reference
    if (reference = "" && parsedData.HasKey("reference"))
        reference := parsedData.reference
    if (reference = "" && parsedData.HasKey("__row"))
        reference := parsedData.__row

    if (reference = "") {
        Log("Parsed object but missing reference: " . jsonContent)
        return ReturnFalse("No reference found on selected order (check sage_reference/reference fields).")
    }

    ; Pull fields (validate basics)
    source := ""
    if (parsedData.HasKey("sage_source"))
        source := parsedData.sage_source
    if (source = "" && parsedData.HasKey("source"))
        source := parsedData.source
    if (source = "" && parsedData.HasKey("warehouse"))
        source := parsedData.warehouse

    vendor := warehouse
    if (vendor = "")
        vendor := source

    ruleSource := parsedData.HasKey("source") ? parsedData.source : source
    date       := NormalizeSageDate(parsedData)
    lineItems  := parsedData.HasKey("sage_lineItems") ? parsedData.sage_lineItems : parsedData.lineItems

    if (!IsObject(lineItems) || lineItems.MaxIndex() < 1) {
        Log("Parsed reference " . reference . " but lineItems missing or empty.")
        return ReturnFalse("Selected order has no lineItems.")
    }

    Log("Loaded order ref=" . reference . " vendor=" . vendor . " source=" . source . " lines=" . lineItems.MaxIndex() . " path=" . jsonFilePath)
    LogSageHealth(sageHwnd)

    ; --- Start interacting with Sage UI ---
    ; Text is sent with {Text} so ! + ^ # { } in a vendor, reference or
    ; description are typed, not pressed as Alt/Shift/Ctrl/Win.

    ; Put focus in Vendor box (Edit1 — the one stable anchor on the form)
    ; tabTo(control, delayMs, altControl := "", shift := false)
    ; SendTab(count, delayMs)
    if !tabTo("Edit1", 200)
        return ReturnFalse("Couldn't find the vendor box (Edit1).")
    Send, {Text}%vendor%
    ; 2s is what a fresh Sage needs; a long-running one needs longer.
    Sleep, 2000
    if !WaitSageSettled(20000, sageHwnd)
        Log("Vendor autocomplete still busy after 20s; carrying on")

    ControlGetText, vendorBox, Edit1, ahk_id %sageHwnd%
    vendorBox := Trim(vendorBox)
    if (vendorBox = "" || !(InStr(vendorBox, vendor) || InStr(vendor, vendorBox)))
        return ReturnFalse("Vendor box shows '" . vendorBox . "', expected '" . vendor . "'.")

    ; Here I will tab away from the warehouse
    ; Then go back to Edit1 and  tab thrice
    ; Leaving the box selects the vendor; Sage loads it and redraws the form.
    SendTab(1, 200)
    if !WaitSageSettled(20000, sageHwnd)
        Log("Vendor record still loading after 20s; carrying on")
    SendTab(2, 200)
    if !tabTo("Edit1", 200, "Edit1", true)
        return ReturnFalse("Couldn't get back to the vendor box after selecting the vendor.")
    SendTab(3, 200)
    WaitSageIdle(5000, sageHwnd)

    Send, {Text}%reference%
    WaitSageIdle(5000, sageHwnd)
    ; Blank can just mean the box isn't readable, so only a different value stops the run.
    refBox := FocusedText(sageHwnd)
    if (refBox = "")
        Log("Reference box read back blank (expected " . reference . ")")
    else if (InStr(reference, refBox) != 1)
        return ReturnFalse("Reference landed in the wrong box: it shows '" . refBox . "', expected '" . reference . "'.")


    ; tabTo("WindowsForms10.BUTTON.app.0.ea7f4a_r30_ad111", 200, "WindowsForms10.BUTTON.app.0.ea7f4a_r29_ad111")
    ; Send, {Space}
    ; Sleep, 200

    ; tabTo("WindowsForms10.EDIT.app.0.ea7f4a_r30_ad17", 100, "WindowsForms10.EDIT.app.0.ea7f4a_r29_ad17")
    
    
    

    ; targetFocus  := "WindowsForms10.EDIT.app.0.ea7f4a_r30_ad16"
    ; targetFocus2 := "WindowsForms10.EDIT.app.0.ea7f4a_r29_ad16"
    ; tabTo(targetFocus, 100, targetFocus2)
    
    SendTab(2, 300)

    Send, %date%
    WaitSageIdle(5000, sageHwnd)
    Log("Date typed " . date . ", box shows '" . FocusedText(sageHwnd) . "'")

    SendTab(8, 100)

    if !tabTo("Edit3", 200, "", true)
        return ReturnFalse("Couldn't find the line-item anchor (Edit3).")
    SendTab(2, 200)

    ; --- Line items ---------------------------------------------------------

    Loop, % lineItems.MaxIndex() {
        idx := A_Index
        extendedRaw := ""  ; reset per line

        try extendedRaw := lineItems[idx].extended

        if !EnsurePurchasesActive("before line " . idx)
            return ReturnFalse("Sage Purchases window lost focus before line " . idx . "; stopped so keystrokes don't land elsewhere. See ahk_sage.log.")

        ; Prefer the CAP/Sage code the app already resolved (single source of
        ; truth — see src/scrapers/capRules.js). Orders scraped before that
        ; existed have no sageCode, so fall back to the legacy ourRules mapper.
        if (lineItems[idx].HasKey("sageCode") && lineItems[idx].sageCode != "") {
            type := lineItems[idx].sageCode
            description := (lineItems[idx].HasKey("sageDescription") && lineItems[idx].sageDescription != "")
                ? lineItems[idx].sageDescription
                : lineItems[idx].partDescription
        } else {
            resultList := ourRules(ruleSource
                , lineItems[idx].partLineCode
                , lineItems[idx].partNumber
                , lineItems[idx].partDescription)

            type        := resultList[1]
            description := resultList[2]
        }

        ; Type out the item "type" char-by-char (keeps Sage autocomplete happy)
        Loop, Parse, type
        {
            Send, {Text}%A_LoopField%
            Sleep, 100
        }
        ; Same floor as before, plus however long a slow Sage needs on top.
        Sleep, 2000
        if !WaitSageSettled(20000, sageHwnd)
            Log("Item autocomplete for " . type . " still busy after 20s; carrying on")

        ; New vs existing item: note where the item column is, Tab, then see
        ; whether the lookup popup opens (new) or focus moves on (existing).
        ControlGetFocus, focusedControl, ahk_id %sageHwnd%
        ControlGetPos, oldX,,,, %focusedControl%, ahk_id %sageHwnd%
        if (focusedControl = "" || oldX = "")
            return ReturnFalse("Couldn't read the item column on line " . idx . " (Sage busy?).")
        Send, {Tab}
        lookup := WaitItemLookup(sageHwnd, oldX, 20000)
        if (lookup = "")
            return ReturnFalse("Line " . idx . " (" . type . "): neither the item popup nor the next column came up within 20s.")

        if (lookup = "new") {
            ; New part — open/create inventory record
            WinWaitActive, Select Inventory/Service, , 20
            if (ErrorLevel)
                return ReturnFalse("Timeout opening 'Select Inventory/Service'.")

            Sleep, 50
            Send, !r
            Sleep, 200

            WinWaitNotActive, Select Inventory/Service, , 5
            if (ErrorLevel)
                return ReturnFalse("'Select Inventory/Service' didn't close.")

            WinWaitActive, Inventory & Services Records, , 20
            if (ErrorLevel) {
                WinWaitActive, Inventory & Services Ledger, , 10
                if (ErrorLevel)
                    return ReturnFalse("Timeout opening 'New inventory' window.")
            }

            SendTab(1, 50)

            cost := lineItems[idx].costPrice + 0.0
            ; Capture extended values if present (safe defaults)
            ; extendedRaw already set at loop start

            ; Price ladder
            if (cost < 21)
                price := cost * 3
            else if (cost < 51)
                price := cost * 2.8
            else if (cost < 61)
                price := cost * 2.7
            else if (cost < 71)
                price := cost * 2.5
            else if (cost < 81)
                price := cost * 2.4
            else if (cost < 91)
                price := cost * 2.25
            else if (cost < 101)
                price := cost * 2.2
            else if (cost < 131)
                price := cost * 2.1
            else
                price := cost * 2.2

            preferred := Round(cost * 1.88, 2)
            price     := Round(price, 2)

            Sleep, 50
            Send, {Text}%description%
            Sleep, 50

            ; Inventory flags / fields (kept as in your flow)
            SendTab(2, 25)
            Send, v
            Sleep, 50
            Send, {Space}
            Sleep, 50

            SendTab(3, 50)
            Loop, 2 {
                Send, {Right}
                Sleep, 25
            }

            SendTab(2, 25)
            Sleep, 50
            Send, %price%
            Sleep, 50

            Loop, 1 {
                Send, {Down}
                Sleep, 25
            }

            Sleep, 50
            Send, %preferred%
            Sleep, 50

            Loop, 1 {
                Send, {Down}
                Sleep, 25
            }
            Sleep, 50
            Send, %cost%
            Sleep, 50

            SendTab(3, 25)
            Loop, 1 {
                Send, {Right}
                Sleep, 25
            }

            SendTab(5, 25)
            Send, 1520
            Sleep, 25
            SendTab(1, 25)
            Send, 4020
            SendTab(1, 25)
            Send, 5020
            SendTab(1, 25)
            Send, 5100
            SendTab(2, 25)

            ; Save new inventory item
            Send, !n
            Sleep, 100

            WinWaitNotActive, Inventory & Services Records, , 20
            if (ErrorLevel)
                return ReturnFalse("'Inventory & Services Records' didn't close.")

            WinWaitActive, Purchases - Creating an Invoice, , 5
            if (ErrorLevel) {
                WinWaitActive, Purchases Journal - Creating an Invoice, , 5
                if (ErrorLevel)
                    return ReturnFalse("Could not return to Purchases window after creating inventory.")
            }

            WaitSageIdle(5000, sageHwnd)
            SendTab(1, 25)
        }

        ; Enter quantity & purchase price (works for both new & existing items)
        WaitSageIdle(5000, sageHwnd)
        quantity := lineItems[idx].quantity
        Send, %quantity%
        Sleep, 50

        SendTab(3, 50)

        purchase_price := lineItems[idx].costPrice
        Send, %purchase_price%
        Sleep, 50

        if (extendedRaw != "") {
            ; MsgBox, 64, Ext Debug, Using extendedRaw branch for line #%idx%`nextendedRaw: %extendedRaw%
            SendTab(3, 25)
            Send, %extendedRaw%
            Sleep, 50
            SendTab(1, 25)
        } else {
            ; MsgBox, 64, Ext Debug, No extendedRaw for line #%idx%, taking fallback branch.
            SendTab(4, 25)
        }
    } ; end loop

    Sleep, 200
    WaitSageIdle(10000, sageHwnd)
    if !EnsurePurchasesActive("before reading the total")
        return ReturnFalse("Sage Purchases window lost focus after the last line; stopped before posting. See ahk_sage.log.")

    WinGetTitle, nowTitle, A
    
    ; inv_total := GetTextByClassRe(nowTitle, "i)^WindowsForms10\.STATIC\.app\.0\.", "i)^\d+(\.\d+)?$")
    inv_total := GetSageTotal(nowTitle, 15)
    Sleep, 200

    billed_total := ""
    if (parsedData.HasKey("billed_total"))
        billed_total := parsedData.billed_total

    if (inv_total != "" && billed_total != "") {
        inv_num := inv_total + 0.0
        billed_num := billed_total + 0.0
        diff := Round(billed_num - inv_num, 2)
        if (Abs(diff) >= 0.001 && Abs(diff) < 0.1) {
            AdjustSageTax(diff)
            inv_num := billed_num
            inv_total := Format("{:.2f}", inv_num)
        }
    }
    ; class regex (prefix only, tail can change)
    ; text regex: 24 or 24.92 etc.

    if !EnsurePurchasesActive("before posting")
        return ReturnFalse("Sage Purchases window lost focus before posting; stopped. See ahk_sage.log.")
    Send, !p
    ;Exit, 7
    Sleep, 1000

    ; Sage sometimes shows a "date precedes session date" confirmation before posting.
    ; Poll for up to ~6s: dismiss it with Y (Yes), then let GetSageTxnNumber wait.
    Loop, 20 {
        if WinExist("Sage 50 - Confirmation") {
            WinActivate, Sage 50 - Confirmation
            Send, y
            Sleep, 500
            break
        }
        if WinExist("Sage 50 - Transaction Confirmation")
            break
        Sleep, 300
    }

    journal_entry := GetSageTxnNumber(10)

    if (journal_entry = ""){
        Log("ERROR: no journal entry number after posting " . reference)
        return false
    } else {
        journal_tax := journal_entry . "    $" . inv_total
        ; Emit result to stdout for Electron to consume; include Sage total for syncing.
        ; The journal line must be the LAST stdout line (extractJournalLine reads it).
        FileAppend, SAGE_TOTAL:%inv_total%`n, *
        FileAppend, %journal_tax%`n, *
        Send {Enter}
        Sleep, 500
        return true
    }
}
