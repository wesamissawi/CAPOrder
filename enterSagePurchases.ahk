#NoEnv
#SingleInstance, Force
SetBatchLines, -1

SendMode, Input
SetWorkingDir, %A_ScriptDir%


SetTitleMatchMode, 2           ; allow partial title matches
DetectHiddenText, On           ; sometimes helps WinGetText
SetWinDelay, 0



#Include %A_ScriptDir%\lib\capRules\rules.ahk
#Include %A_ScriptDir%\lib\helpers.ahk


; --- Main ------------------------------------------------------------------

makePurchaseFromJSON(pathToFile, warehouse) {
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

    jsonFilePath := pathToFile
    if !FileExist(jsonFilePath)
        return ReturnFalse("File not found:`n" . jsonFilePath)

    ; Read file with retries (handles slow writes to disk)
    maxAttempts := 4
    attempts := 0
    jsonContent := ""
    while (attempts < maxAttempts && !jsonContent) {
        try {
            jsonContent := ReadFileContent(jsonFilePath)
        } catch e {
            return ReturnFalse("File read failed:`n" . jsonFilePath)
        }
        attempts++
        if (!jsonContent)
            Sleep, 150
    }
    if (!jsonContent)
        return ReturnFalse("No JSON content after " . maxAttempts . " attempts.`nTry running the script again.")

    ; Parse JSON with retries (handles partially written JSON)
    attempts := 0
    parsedData := ""
    reference := ""
    while (attempts < maxAttempts && (!IsObject(parsedData) || !reference)) {
        try {
            json := new JSON()
            parsedData := json.Load(jsonContent)
            reference := parsedData.reference
        } catch e {
            ; try again after a brief pause
        }
        attempts++
        if (!reference)
            Sleep, 150
    }
    if (!IsObject(parsedData) || !reference)
        return ReturnFalse("JSON parsing failed or missing 'reference' after " . maxAttempts . " attempts.")

    ; Pull fields (validate basics)
    source     := parsedData.source
    date       := parsedData.date
    lineItems  := parsedData.lineItems

    if (!IsObject(lineItems) || lineItems.MaxIndex() < 1)
        return ReturnFalse("JSON missing 'lineItems' or it's empty.")

    ; --- Start interacting with Sage UI ---

    ; Put focus in Vendor box (assumes your tabTo/SendTab functions exist)
    ; If tabTo is in another file, ensure it is #Included.
    ; tabTo(control, delayMs, altControl := "", mustMatch := false)
    ; SendTab(count, delayMs)
    tabTo("Edit1", 200)
    Send, %warehouse%
    Sleep, 2000


    ; Here I will tab away from the warehouse
    ; Then go back to Edit1 and  tab thrice


    SendTab(3, 200)
    tabTo("Edit1", 200, "Edit1", true)
    SendTab(3, 200)

    Sleep, 100
    Send, %reference%
    Sleep, 100


    ; tabTo("WindowsForms10.BUTTON.app.0.ea7f4a_r30_ad111", 200, "WindowsForms10.BUTTON.app.0.ea7f4a_r29_ad111")
    ; Send, {Space}
    ; Sleep, 200

    ; tabTo("WindowsForms10.EDIT.app.0.ea7f4a_r30_ad17", 100, "WindowsForms10.EDIT.app.0.ea7f4a_r29_ad17")
    
    
    

    ; targetFocus  := "WindowsForms10.EDIT.app.0.ea7f4a_r30_ad16"
    ; targetFocus2 := "WindowsForms10.EDIT.app.0.ea7f4a_r29_ad16"
    ; tabTo(targetFocus, 100, targetFocus2)
    
    SendTab(2, 300)

    Send, %date%

    SendTab(8, 100)

    tabTo("Edit3", 200, targetFocus2, true)
    SendTab(2, 200)

    ; --- Line items ---------------------------------------------------------

    Loop, % lineItems.MaxIndex() {
        idx := A_Index

        ; your custom rule mapper: should return [type, description]
        resultList := ourRules(source
            , lineItems[idx].partLineCode
            , lineItems[idx].partNumber
            , lineItems[idx].partDescription)

        type        := resultList[1]
        description := resultList[2]

        ; Type out the item "type" char-by-char (keeps Sage autocomplete happy)
        Loop, Parse, type
        {
            Send, %A_LoopField%
            Sleep, 100
        }
        Sleep, 2000

        ; Check if the same control column (new vs existing item logic)
        ControlGetFocus, focusedControl, A
        Sleep, 50
        ControlGetPos, oldX, oldY,,, %focusedControl%
        Sleep, 50
        Send, {Tab}
        Sleep, 100
        ControlGetFocus, focusedControl, A
        Sleep, 50
        ControlGetPos, x, y,,, %focusedControl%
        Sleep, 100

        if (oldX == x) {
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
            Send, %description%
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

            Sleep, 100
            SendTab(1, 25)
        }

        ; Enter quantity & purchase price (works for both new & existing items)
        quantity := lineItems[idx].quantity
        Send, %quantity%
        Sleep, 50

        SendTab(3, 50)

        purchase_price := lineItems[idx].costPrice
        Send, %purchase_price%
        Sleep, 50

        SendTab(4, 25)
    } ; end loop

    Sleep, 200

    WinGetTitle, nowTitle, A
    
    ; inv_total := GetTextByClassRe(nowTitle, "i)^WindowsForms10\.STATIC\.app\.0\.", "i)^\d+(\.\d+)?$")
    inv_total := GetSageTotal(nowTitle, 15)
    Sleep, 200
    ; class regex (prefix only, tail can change)
    ; text regex: 24 or 24.92 etc.

    ; Get the bill tototal
    ; MsgBox, %inv_total%

    ; MsgBox, "Leave the script if you want to now"

    Send, !p
    Sleep, 1000

    journal_entry := GetSageTxnNumber(10)

    if (journal_entry = ""){
        return false
    }
    else{
        ; MsgBox, %journal_entry%     %inv_total%
        journal_tax := journal_entry . "    $" . inv_total
        ; Msgbox, %journal_tax%
        if (UpdateOrderJournal(reference, journal_tax)){
            ; MsgBox, 64, Done, Updated %reference% with journal %journal_tax%.
            Send {Enter}
            Sleep, 500
            return true
        }
           
        else{
            MsgBox, 48, Failed, Update failed.  ; details shown in earlier MsgBoxes
            return false    ; reference
        }
            
        
    }



    Dbg("Reference: " . reference)
    return true
}
