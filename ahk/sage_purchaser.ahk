#Include %A_ScriptDir%\lib\enterSagePurchases.ahk

; Allow running the purchase flow directly:
;   autohotkey.exe sage_purchaser.ahk "C:\path\order-or-orders.json" "REF123" "VendorCode" "C:\path\orders.json"
if (A_LineFile = A_ScriptFullPath) {
    ordersPath := ""
    orderRef   := ""
    vendorArg  := ""
    updatePath := ""

    if (IsObject(A_Args)) {
        if (A_Args.Length() >= 1)
            ordersPath := A_Args[1]
        if (A_Args.Length() >= 2)
            orderRef := A_Args[2]
        if (A_Args.Length() >= 3)
            vendorArg := A_Args[3]
        if (A_Args.Length() >= 4)
            updatePath := A_Args[4]
    } else {
        ordersPath := %1%
        orderRef   := %2%
        vendorArg  := %3%
        updatePath := %4%
    }

    if (ordersPath = "") {
        MsgBox, 16, Error, Please pass the orders.json path as the first argument.
        ExitApp, 2
    }

    if (makePurchaseFromJSON(ordersPath, vendorArg, orderRef, updatePath))
        ExitApp, 0

    ExitApp, 1
}
