#NoEnv
#SingleInstance, Force
SetBatchLines, -1
SendMode, Input
SetWorkingDir, %A_ScriptDir%
SetTitleMatchMode, 2
DetectHiddenText, On
SetWinDelay, 0

; --- your existing includes (for JSON(), ourRules(), ReadFileContent, etc.) ---
#Include %A_ScriptDir%\lib\capRules\rules.ahk
#Include %A_ScriptDir%\lib\helpers.ahk

; =========================
; Public entry point
; =========================
; Usage: savePurchaseToFiles("C:\path\incoming.json", "Transbec")
savePurchaseToFiles(pathToFile, warehouse) {
    ; ---------- Read file (robust) ----------
    if !FileExist(pathToFile)
        return ReturnFalse("File not found:`n" . pathToFile)

    maxAttempts := 4
    attempts := 0
    jsonContent := ""
    while (attempts < maxAttempts && !jsonContent) {
        try {
            jsonContent := ReadFileContent(pathToFile) ; from helpers.ahk
        } catch e {
            return ReturnFalse("File read failed:`n" . pathToFile)
        }
        attempts++
        if (!jsonContent)
            Sleep, 150
    }
    if (!jsonContent)
        return ReturnFalse("No JSON content after " . maxAttempts . " attempts.")

    ; ---------- Parse JSON ----------
    attempts := 0
    parsedData := ""
    reference := ""
    while (attempts < maxAttempts && (!IsObject(parsedData) || !reference)) {
        try {
            json := new JSON()
            parsedData := json.Load(jsonContent)

            ; expected fields from your current producer
            reference := parsedData.reference              ; warehouse reference (string)
            source    := parsedData.source                 ; warehouse name (string)
            dateIn    := parsedData.date                   ; as you typed to Sage
            invNum    := parsedData.invoiceNumber          ; may not exist -> blank later
            lineItems := parsedData.lineItems              ; array of objects
        } catch e {
            ; retry
        }
        attempts++
        if (!reference)
            Sleep, 150
    }
    if (!IsObject(parsedData) || !reference)
        return ReturnFalse("JSON parsing failed or missing 'reference'.")

    if (!IsObject(lineItems) || lineItems.MaxIndex() < 1)
        return ReturnFalse("JSON missing 'lineItems' or it's empty.")

    if (source = "")
        source := warehouse  ; fall back to provided warehouse arg if producer left it blank

    ; ---------- Build order JSON (your target shape) ----------
    dateDDMMYYYY := NormalizeDateToDDMMYYYY(dateIn)  ; robust normalizer below
    if (dateDDMMYYYY = "")
        dateDDMMYYYY := A_DD . A_MM . A_YYYY

    ; transform each line via your rules (ourRules returns [our_part_number, our_part_description])
    transformedLines := []
    for idx, li in lineItems {
        ; input producer uses: li.partLineCode, li.partNumber, li.partDescription, li.costPrice, li.quantity
        resultList := ourRules(source, li.partLineCode, li.partNumber, li.partDescription)
        ourPN  := resultList[1]
        ourDesc := resultList[2]

        oneLine := {}
        oneLine["warehouse_line_code"]     := ToStr(li.partLineCode)
        oneLine["warehouse_part_number"]   := ToStr(li.partNumber)
        oneLine["warehouse_part_description"] := ToStr(li.partDescription)
        oneLine["cost"]                    := ToStr(li.costPrice)
        oneLine["quantity_ordered"]        := ToStr(li.quantity)
        oneLine["our_part_number"]         := ToStr(ourPN)
        oneLine["our_part_description"]    := ToStr(ourDesc)
        transformedLines.Push(oneLine)
    }

    orderOut := {}
    orderOut["warehouse"]        := ToStr(source)
    orderOut["reference_number"] := ToStr(reference)
    orderOut["invoice_number"]   := ToStr(invNum)        ; may be ""
    orderOut["date"]             := ToStr(dateDDMMYYYY)
    orderOut["line code"]        := transformedLines     ; <- key name exactly as requested

    ; ---------- Ensure folder and write all_orders/{ref}__{warehouse}__{date}.json ----------
    ordersDir := A_ScriptDir . "\..\Order_Items\all_orders"
    EnsureDir(ordersDir)
    safeRef   := SanitizeForFile(ToStr(reference))
    safeWh    := SanitizeForFile(ToStr(source))
    fileName  := safeRef . "__" . safeWh . "__" . dateDDMMYYYY . ".json"
    destPath  := ordersDir . "\" . fileName

    if !WriteJSON(destPath, orderOut)
        return ReturnFalse("Failed writing order file:`n" . destPath)

    ; ---------- Update outstanding_items.json (append objects) ----------
    outstandingPath := A_ScriptDir . "\..\Order_Items\outstanding_items.json"
    outstanding := LoadJSONArray(outstandingPath) ; [] if file missing/empty

    for idx, li in transformedLines {
        qtyInt := ToInt(li["quantity_ordered"])
        obj := {}
        obj["itemcode"]        := ToStr(li["our_part_number"])  ; “whatever our line item” = our PN
        obj["quantity"]        := qtyInt                         ; INT
        obj["alocated_to"]     := ""                             ; as spelled in prompt
        obj["allocated_for"]   := ""
        obj["cost"]            := ToStr(li["cost"])
        obj["date"]            := dateDDMMYYYY
        obj["reference_num"]   := ToStr(reference)
        obj["invoice_num"]     := ToStr(invNum)                  ; "" if not available
        obj["sold_status"]     := ""
        obj["sold_date"]       := ""
        obj["notes1"]          := ""
        obj["notes2"]          := ""
        obj["invoiced status"] := ""                             ; keep exact key name with space
        obj["invoiced date"]   := ""
        outstanding.Push(obj)
    }

    if !WriteJSON(outstandingPath, outstanding)
        return ReturnFalse("Failed updating outstanding_items.json")

    ; done
    return true
}

; =========================
; Helpers (self-contained)
; =========================

; Write any AHK object as JSON to file (UTF-8, overwrite)
WriteJSON(path, obj) {
    try {
        json := new JSON()
        ; dump normally — no extra "UTF-8" string
        text := json.Dump(obj, 1)  ; 1 = pretty (optional)
        f := FileOpen(path, "w", "UTF-8")  ; proper encoding
        if !IsObject(f)
            return false
        f.Write(text)
        f.Close()
        return true
    } catch e {
        return false
    }
}


; Load a JSON array file, or return [] on any issue
LoadJSONArray(path) {
    if !FileExist(path)
        return []  ; new
    content := ""
    try {
        content := ReadFileContent(path)
    } catch e {
        return []   ; safe default
    }
    if (Trim(content) = "")
        return []
    try {
        json := new JSON()
        data := json.Load(content)
        if IsObject(data)
            return data
    } catch e { 
        ; handle error (optional)
    }
    return []  ; fallback if corrupt
}

EnsureDir(dirPath) {
    if !FileExist(dirPath)
        FileCreateDir, %dirPath%
}

; Sanitize strings to be safe for filenames
SanitizeForFile(s) {
    s := ToStr(s)
    bad := "\\/:*?""<>|"
    Loop, Parse, bad
        s := StrReplace(s, A_LoopField, "_")
    s := Trim(s)
    return s
}

; Coerce to string (avoids "blank"/0 pitfalls)
ToStr(v) {
    if (v = "")
        return ""
    return "" . v
}

; Coerce to int (defaults to 0 if blank/non-numeric)
ToInt(v) {
    v := "" . v
    if RegExMatch(v, "^\s*-?\d+")
        return v + 0
    ; handle decimals like "3.0"
    if RegExMatch(v, "^\s*-?\d+\.\d+")
        return Floor(v + 0.0)
    return 0
}

; Accepts common inputs like:
;  - "DD/MM/YYYY", "DD-MM-YYYY", "DD.MM.YYYY"
;  - "YYYY-MM-DD", "YYYY/MM/DD"
;  - "DDMMYYYY" (already OK)
; Returns "DDMMYYYY" or "" if impossible.
NormalizeDateToDDMMYYYY(s) {
    s := Trim("" . s)

    ; already 8 digits DDMMYYYY
    if RegExMatch(s, "^\d{8}$")
        return s

    ; 6 digits DDMMYY → expand to DDMM20YY
    if RegExMatch(s, "^\d{6}$") {
        dd := SubStr(s, 1, 2)
        mm := SubStr(s, 3, 2)
        yy := SubStr(s, 5, 2)
        return dd . mm . "20" . yy
    }

    ; YYYY[-/ .]MM[-/ .]DD
    if RegExMatch(s, "i)^\s*(\d{4})\D(\d{1,2})\D(\d{1,2})\s*$", m) {
        dd := Format("{:02}", m3), mm := Format("{:02}", m2), yy := m1
        return dd . mm . yy
    }

    ; DD[-/ .]MM[-/ .]YYYY
    if RegExMatch(s, "i)^\s*(\d{1,2})\D(\d{1,2})\D(\d{4})\s*$", m) {
        dd := Format("{:02}", m1), mm := Format("{:02}", m2), yy := m3
        return dd . mm . yy
    }

    return ""
}


; ReturnFalse helper (optional; mirror your style)
;ReturnFalse(msg) {
;    MsgBox, 48, Error, %msg%
;    return false
;}
