#Include %A_ScriptDir%\lib\enterSagePurchases.ahk

; update_invoice.ahk
; Args: orderJsonPath, orderRef (optional)

orderPath := ""
orderRef  := ""
if (IsObject(A_Args)) {
    if (A_Args.Length() >= 1)
        orderPath := A_Args[1]
    if (A_Args.Length() >= 2)
        orderRef := A_Args[2]
} else {
    orderPath := %1%
    orderRef  := %2%
}

if (orderPath = "") {
    MsgBox, 16, Error, Please pass the order JSON path as the first argument.
    ExitApp, 2
}

; --- Load order JSON ---
try {
    json := new JSON()
    rawData := json.Load(ReadFileContent(orderPath))
} catch e {
    MsgBox, 16, Error, Failed to read/parse order JSON: %orderPath%
    ExitApp, 3
}

if (!IsObject(rawData)) {
    MsgBox, 16, Error, Order JSON is not an object.
    ExitApp, 4
}

order := rawData
if (rawData.MaxIndex()) {
    order := SelectOrderFromJson(rawData, orderRef)
}

if (!IsObject(order)) {
    MsgBox, 16, Error, Could not select order from JSON.
    ExitApp, 5
}

oldRef := ""
newRef := ""
if (order.HasKey("sage_reference_synced"))
    oldRef := order.sage_reference_synced
if (oldRef = "" && order.HasKey("reference"))
    oldRef := order.reference
if (order.HasKey("sage_reference"))
    newRef := order.sage_reference
if (newRef = "" && order.HasKey("source_invoice"))
    newRef := order.source_invoice

if (oldRef = "" || newRef = "") {
    MsgBox, 16, Error, Missing sage_reference_synced or sage_reference in JSON.
    ExitApp, 6
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
        ExitApp, 7
    }
}

Sleep, 200

; Navigate to reference field and enter old reference
tabTo("Edit1", 200)
SendTab(3, 200)
tabTo("Edit1", 200, "Edit1", true)
SendTab(3, 200)
Sleep, 100
Send, %oldRef%
SendTab(1, 200)
Send, {Enter}
Sleep, 1000
Send, ^a

; Back to Edit1 and move to invoice field for new reference
tabTo("Edit1", 200)
SendTab(3, 200)
tabTo("Edit1", 200, "Edit1", true)
SendTab(8, 200)
Sleep, 100
Send, %newRef%

; Post update
Send, !p
Sleep, 1000

journal_entry := GetSageTxnNumber(10)

;MsgBox, 64, Update Invoice, Journal captured:`n%journal_entry%

; Emit journal to stdout for Electron logging; do not write JSON
if (journal_entry != "") {
    FileAppend, %journal_entry%`n, *
}

; Dismiss the final Sage window/dialog left open after posting.
Send, {Enter}
Sleep, 500

ExitApp, 0
