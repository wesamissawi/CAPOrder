#Include %A_ScriptDir%\lib\enterSagePurchases.ahk

; Args: orderJsonPath, orderRef (optional), delta (optional)
orderPath := ""
orderRef  := ""
deltaArg  := ""

if (IsObject(A_Args)) {
    if (A_Args.Length() >= 1)
        orderPath := A_Args[1]
    if (A_Args.Length() >= 2)
        orderRef := A_Args[2]
    if (A_Args.Length() >= 3)
        deltaArg := A_Args[3]
} else {
    orderPath := %1%
    orderRef  := %2%
    deltaArg  := %3%
}

if (orderPath = "") {
    MsgBox, 16, Error, Please pass the order JSON path as the first argument.
    FileAppend, RECONCILE_ERROR:missing-path`n, *
    ExitApp, 2
}

; --- Load order JSON ---
try {
    json := new JSON()
    rawData := json.Load(ReadFileContent(orderPath))
} catch e {
    MsgBox, 16, Error, Failed to read/parse order JSON: %orderPath%
    FileAppend, RECONCILE_ERROR:parse-failed`n, *
    ExitApp, 3
}

if (!IsObject(rawData)) {
    MsgBox, 16, Error, Order JSON is not an object.
    FileAppend, RECONCILE_ERROR:not-object`n, *
    ExitApp, 4
}

order := rawData
if (rawData.MaxIndex()) {
    order := SelectOrderFromJson(rawData, orderRef)
}

if (!IsObject(order)) {
    MsgBox, 16, Error, Could not select order from JSON.
    FileAppend, RECONCILE_ERROR:order-select-failed`n, *
    ExitApp, 5
}

ref := ""
if (order.HasKey("sage_reference_synced"))
    ref := order.sage_reference_synced
if (ref = "" && order.HasKey("sage_reference"))
    ref := order.sage_reference
if (ref = "" && order.HasKey("reference"))
    ref := order.reference
if (ref = "" && order.HasKey("__row"))
    ref := order.__row

if (ref = "") {
    MsgBox, 16, Error, Missing reference on order.
    FileAppend, RECONCILE_ERROR:missing-ref`n, *
    ExitApp, 6
}

delta := ""
if (deltaArg != "") {
    delta := deltaArg + 0.0
} else {
    billed := ""
    sageTotal := ""
    if (order.HasKey("billed_total"))
        billed := order.billed_total
    if (billed = "" && order.HasKey("billedTotal"))
        billed := order.billedTotal
    if (order.HasKey("sage_total_synced"))
        sageTotal := order.sage_total_synced
    if (sageTotal = "" && order.HasKey("sageTotalSynced"))
        sageTotal := order.sageTotalSynced

    if (billed = "" || sageTotal = "") {
        MsgBox, 16, Error, Missing billed_total or sage_total_synced to reconcile.
        FileAppend, RECONCILE_ERROR:missing-totals`n, *
        ExitApp, 7
    }
    delta := Round((billed + 0.0) - (sageTotal + 0.0), 2)
}

if (delta = "" || Abs(delta) < 0.001) {
    ExitApp, 0
}

; Focus Sage window
if WinExist("Purchases - Creating an Invoice") {
    WinActivate
    WinMaximize
}
if WinExist("Purchases Journal - Creating an Invoice") {
    WinActivate
    WinMaximize
}
WinWaitActive, Purchases - Creating an Invoice, , 5
if (ErrorLevel) {
    WinWaitActive, Purchases Journal - Creating an Invoice, , 5
    if (ErrorLevel) {
        MsgBox, 16, Error, Could not activate Sage Purchases window.
        FileAppend, RECONCILE_ERROR:window-not-found`n, *
        ExitApp, 8
    }
}

Sleep, 200

; Navigate to reference field, enter ref to load invoice
tabTo("Edit1", 200)
SendTab(3, 200)
tabTo("Edit1", 200, "Edit1", true)
SendTab(3, 200)
Sleep, 100
Send, %ref%
SendTab(1, 200)
Send, {Enter}
; Give Sage time to load the invoice before we start adjusting fields
Sleep, 1200

Send, ^a
Sleep, 1000



; Ensure focus back on Edit1 before adjusting tax
tabTo("Edit1", 200)

result := AdjustSageTax(delta)
if (!result) {
    FileAppend, RECONCILE_ERROR:adjust-failed`n, *
    MsgBox, 16, Reconcile, AdjustSageTax failed. Aborting reconcile.
    ExitApp, 9
}

; Wait for Sage to finish recalculating the invoice total after the tax change
Sleep, 800

; Capture updated Sage total
WinGetTitle, nowTitle, A
sage_total := GetSageTotal(nowTitle, 15)
Sleep, 200

; Post/update
Send, !p
Sleep, 1000

journal_entry := GetSageTxnNumber(10)
if (journal_entry = "") {
    FileAppend, RECONCILE_ERROR:journal-missing`n, *
    MsgBox, 16, Reconcile, Missing journal entry after reconcile.
    ExitApp, 10
}

journal_line := journal_entry
if (sage_total != "")
    journal_line := journal_line . "    $" . sage_total

if (sage_total != "")
FileAppend, DELTA_APPLIED:%delta%`n, *
if (sage_total != "")
    FileAppend, SAGE_TOTAL:%sage_total%`n, *
FileAppend, %journal_line%`n, *
Send {Enter}
Sleep, 500

ExitApp, 0
