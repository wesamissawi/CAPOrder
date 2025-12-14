; ─────────────────────────────────────────────────────────────────────────────
; manageNewOrders.ahk
; - Provides AddNewOrders() for merging newOrders into allOrders with defaults.
; - Include-safe (no directives/includes).
; - Standalone-safe: if run directly, accepts command-line args:
;       1) allOrders.json path
;       2) newOrders.json path
;       3) default warehouse (optional, defaults to "TestWarehouse")
;   Example:
;       autohotkey.exe Utils\manageNewOrders.ahk "C:\path\allOrders.json" "C:\path\newOrders.json" "MyWarehouse"
; ─────────────────────────────────────────────────────────────────────────────

; ========== PUBLIC API ==========
AddNewOrders(allOrdersPath, newOrdersPath, defaultWarehouse := "TestWarehouse") {
    json := new JSON()
    ;MsgBox, newOrders path is : %newOrdersPath%
    ; --- Load or initialize allOrders ---
    if FileExist(allOrdersPath) {
        FileRead, allOrdersText, %allOrdersPath%
        if (ErrorLevel) {
            MsgBox, 16, Error, Failed to read %allOrdersPath%.
            return false
        }
        allOrders := json.Load(allOrdersText)
        if !IsObject(allOrders)
            allOrders := []
    } else {
        allOrders := []
    }

    ; --- Build lookup of existing references ---
    existing := {}
    for i, order in allOrders {
        ; MsgBox, i is %i%  Order is %order%
        ref := CleanRef(order.reference)
        if (ref != "")
            existing[ref] := true
    }

    ; --- Load newOrders ---
    if !FileExist(newOrdersPath) {
        MsgBox, 16, Error, Missing %newOrdersPath%.
        return false
    }
    FileRead, newOrdersText, %newOrdersPath%
    if (ErrorLevel) {
        MsgBox, 16, Error, Failed to read %newOrdersPath%.
        return false
    }
    newRefsRaw := json.Load(newOrdersText)
    ;MsgBox, newRefsRaw
    if !IsObject(newRefsRaw) {
        MsgBox, 16, Error, %newOrdersPath% did not parse as a JSON array.
        return false
    }

    ; --- Process and add missing ---
    addedCount := 0
    ;MsgBox, %newRefsRaw%
    for i, rawItem in newRefsRaw {
        ;MsgBox, i: %i% rawitem: %rawitem%
        for k, ref in SplitRefs(rawItem) {
            ref := CleanRef(ref)
            
            if (ref = "")
                continue
            if !existing.HasKey(ref) {
                
                order := {}
                order.warehouse := defaultWarehouse
                order.reference := ref
                order.enteredInSage := false

                ; journalEntry: null if supported, else ""
                if (IsFunc("JSON.Null"))
                    order.journalEntry := JSON.Null()
                else
                    order.journalEntry := ""

                order.pickedUp := false
                order.inStore := false

                ; invoiceNum: null if supported, else ""
                if (IsFunc("JSON.Null"))
                    order.invoiceNum := JSON.Null()
                else
                    order.invoiceNum := ""

                order.invoiceSageUpdate := false
                order.invoiceValueCheck := false

                allOrders.Push(order)
                existing[ref] := true
                addedCount++
            }
        }
    }

    ; --- Save back to file (pretty) ---
    outText := json.Dump(allOrders, "", "    ")
    FileDelete, %allOrdersPath%
    FileAppend, %outText%, %allOrdersPath%

    ; Return a small result object for programmatic use
    result := {}
    result.added := addedCount
    result.total := allOrders.MaxIndex() ? allOrders.MaxIndex() : 0
    return result
}

; ========== HELPERS ==========
CleanRef(str) {
    str := Trim(str)
    str := RegExReplace(str, "[^A-Za-z0-9_-]", "")
    return str
}

SplitRefs(raw) {
    arr := []
    if (!IsObject(raw))
        raw := "" . raw
    cleaned := RegExReplace(raw, "[^A-Za-z0-9_-]+", " ")
    cleaned := Trim(cleaned)
    if (cleaned = "")
        return arr
    parts := StrSplit(cleaned, A_Space)
    for i, p in parts {
        p := Trim(p)
        if (p != "")
            arr.Push(p)
    }
    return arr
}

; ========== STANDALONE RUNNER ==========
; Only executes if this file is run directly (not when #Included).
if (A_LineFile = A_ScriptFullPath) {
    ; Optional: set working dir to the script folder when run standalone.
    SetWorkingDir, %A_ScriptDir%

    ; Parse command-line args:
    ;   %1% -> allOrders.json
    ;   %2% -> newOrders.json
    ;   %3% -> default warehouse (optional)
    allOrdersPath := %1%
    newOrdersPath := %2%
    defaultWh     := %3%

    if (allOrdersPath = "" || newOrdersPath = "") {
        MsgBox, 48, Usage,
        ( LTrim
            Usage:
              autohotkey.exe "%A_ScriptFullPath%" "C:\path\allOrders.json" "C:\path\newOrders.json" "WarehouseName (optional)"

            Tip:
              Place JSON.ahk in a standard Lib path (e.g. "%A_ScriptDir%\Lib\JSON.ahk")
              or ensure your main script #Includes it before calling AddNewOrders().
        )
        ExitApp
    }

    if (defaultWh = "")
        defaultWh := "TestWarehouse"

    res := AddNewOrders(allOrdersPath, newOrdersPath, defaultWh)
    if (res) {
        msg := "Added " . res.added . " new order(s). Total entries now: " . res.total . "."
        MsgBox, 64, Done, %msg%

        ;MsgBox, 64, Done, Added % (res.added) " new order(s). Total entries now: " res.total "."
    } else {
        ; AddNewOrders already showed an error dialog.
    }
    ExitApp
}
