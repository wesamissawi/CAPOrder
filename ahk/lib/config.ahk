#SingleInstance, Force
SendMode Input
SetWorkingDir, %A_ScriptDir%


; ---- Exit code constants ----
SUCCESS_NO_UPDATE := 0     ; ran fine but don't touch JSON
SUCCESS_UPDATE    := 101   ; ran fine and SHOULD update JSON
ERR_USER_ABORT    := 9     ; user chose to abort from tray
ERR_TIMEOUT       := 21    ; e.g., WinWaitActive timed out
ERR_GENERIC       := 1


; ; Optional: custom tray so you can choose the outcome explicitly
; Menu, Tray, NoStandard
; Menu, Tray, Add, Exit (Abort), TrayAbort
; Menu, Tray, Add, Exit (Success + Update), TraySuccessUpdate
; Menu, Tray, Add, Exit (No Update), TraySuccessNoUpdate




; ---- Resolve paths RELATIVE TO THIS CONFIG FILE ---------------------------
; A_LineFile is the full path to this file (even when included)
SplitPath, A_LineFile, , __CFG_DIR

; From ahk\lib\sites.ahk up to the project root:
;   sites.ahk   -> ahk\lib  -> .. (ahk) -> .. (project root)
__ROOT := __CFG_DIR . "\..\.."

; Convenience joiner: ConfigJoin("js","clicks","worldClickOrderRef.js")
ConfigJoin(parts*) {
    global __ROOT
    path := __ROOT
    for i, part in parts
        path .= "\" . part
    return path
}


global sites := {}

sites["World"] := { "jsCode": "getWorldOrders.js"
                , "title_pattern" : "Entrepot de Montreal"
                , "saveTitle": " wants to save"
                , "jsOpenOrderLink" : ConfigJoin("js","clicks","worldClickOrderRef.js")
                , "jsOpenOrderList" : ConfigJoin("js","clicks","worldClickOrders.js")
                , "jsgetAllOrders"  : ConfigJoin("js","getOrders","getAllWorldOrders.js")
                , "jsgetOrderinfo"  : ConfigJoin("js","getOrders","getWorldOrder.js")
                , "jsonNewOrders"   : ConfigJoin("Orders","newOrders.json")
                , "jsonTarget"      : ConfigJoin("Orders","tempOrder.json")
                , "sageVendorName"  : "WOR505" }

sites["Transbec"] := { "jsCode": "getTransbecOrders.js"
                    , "title_pattern" : "Transbec Inc."
                    , "saveTitle": " wants to save" 
                    , "saveRefTitle": "orderstransbec.com wants to save"
                    , "jsOpenOrderLink" : ConfigJoin("js","clicks","transbecClickOrderRef.js")
                    , "jsOpenOrderList" : ConfigJoin("js","clicks","transbecClickOrders.js")
                    , "jsgetAllOrders"  : ConfigJoin("js","getOrders","getAllTransbecOrders.js")
                    , "jsgetOrderinfo"  : ConfigJoin("js","getOrders","getTransbecOrder.js")
                    , "jsonNewOrders"   : ConfigJoin("Orders","newOrders.json")
                    , "jsonTarget"      : ConfigJoin("Orders","tempOrder.json")
                    , "sageVendorName"  : "TRA505" }



sites["Nova"] := { "jsCode": "getNovaOrders.js"
                , "title_pattern" : "Invoice Date"
                , "saveTitle": "eoffice.epartconnection.com wants to save"  
                , "saveRefTitle": "eoffice.epartconnection.com wants to save"
                , "jsOpenOrderLink" : ConfigJoin("js","clicks","novaClickOrderRef.js")
                , "jsOpenOrderList" : ConfigJoin("js","clicks","novaClickOrders.js")
                , "jsgetAllOrders"  : ConfigJoin("js","getOrders","getAllNovaOrders.js")
                , "jsgetOrderinfo"  : ConfigJoin("js","getOrders","getNovaOrder.js")
                , "jsonNewOrders"   : ConfigJoin("Orders","newOrders.json")
                , "jsonTarget"      : ConfigJoin("Orders","tempOrder.json")
                , "sageVendorName"  : "PRO505" }

sites["Bestbuy"] := { "jsCode": "getBestBuyOrders.js"
                    , "title_pattern" : "Bestbuy Distributors"
                    , "saveTitle": "bestbuy.bestautoconnect.ca wants to save" }

sites["CBK"] := { "jsCode": "getCBKOrders.js"
                , "title_pattern" : "Capp e-Store :: Order"
                , "saveTitle": "cbklink.cappcon.com:32000 wants to save" }


