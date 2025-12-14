#Include %A_ScriptDir%\lib\capRules\specificRules.ahk


ourRules(warehouse, linecode, partnumber, description) {



    newdescription := description

    if (warehouse = "World"){

        if (linecode = "FRA"){

            if ( SubStr(partnumber, 1, 2) = "DL") {
                ; Concatenate specified string and partnumber
                result := "DEF " . partnumber
            }
            else if ( (SubStr(partnumber, 1, 2) = "CA" || SubStr(partnumber, 1, 2) = "FT" ) ){
                result := partnumber
            }
            else if ( (SubStr(partnumber, 1, 2) = "CH" || SubStr(partnumber, 1, 2) = "CF") ){
                result := "FR " . partnumber
            }
            else if ( SubStr(partnumber, 1, 2) = "DA") {
                result := "VIP " . SubStr(partnumber, 3)  ; Extract partnumber without the first two characters
            }
            else {
                result := linecode . " " . partnumber
                newdescription := description

            }


        }
        else if (linecode = "NGK"){


            if ( (InStr(description, "Oxygen") || InStr(description, "NTK") || InStr(description, "o2"))) {
                result := "NTK " . partnumber
            }
            else if (SubStr(description, 1, 3) = "RC-") {
                newdescription := "IGNITION WIRES " . description
                result := "NGK " . partnumber
            }
            else {
                result := linecode . " " . partnumber
                newdescription := description

            }







        }

        else if(linecode = "BSH" && (InStr(description, "WIPER") > 0   || InStr(description, "BLADE") > 0 )    )   {

            result := "BOS " . partnumber
        }
        else if (linecode = "LUA") {
            result := "LUC " . partnumber
        }
        else if (linecode = "ULR") {
            result := "ASR " . StrReplace(partnumber, "-", "")
        }
        else if (linecode = "EUR"){
            if ( (InStr(description, "SHOE") )) {
                result := "ALS" . partnumber
            }
            else if (  (SubStr(partnumber, 1, 3) = "F1D"  || SubStr(partnumber, 1, 2) = "ID") ) {
                result := "EUR " . StrReplace(partnumber, "-", "")
            }
            else {
                result := linecode . " " . partnumber
                newdescription := description

            }

        }
        else if (linecode = "SPE" && (SubStr(partnumber, 1, 2) = "C-" ) ) {
            result := "SPE " . StrReplace(partnumber, "-", "")
        }
        else if (linecode = "TRK" ) {
            result := "TRK " . StrReplace(partnumber, "-", "")
        }
        else if (linecode = "WAG" && (SubStr(partnumber, 1, 2) = "QC" || SubStr(partnumber, 1, 2) = "ZD" || SubStr(partnumber, 1, 2) = "MX" || SubStr(partnumber, 1, 2) = "PD" || SubStr(partnumber, 1, 2) = "SX")) {
            result := partnumber
        }
        else if (linecode = "PRO") {
            result :=  partnumber
        }
        else{
            result := linecode . " " . partnumber
            newdescription := description

        }

    }
    else if (warehouse = "Transbec"){

        result := interchange("trsToCAP.json", partnumber)

        if (result = "") {
            ;MsgBox No interchage for trs


            if (SubStr(partnumber, 1, 3) = "BCD") {
                result := "BCD " . Trim(SubStr(partnumber, 4))
                newdescription := "Bremsen Ceramic Disc Pads"  ; Set the new description
            }
            else if (SubStr(partnumber, 1, 2) = "TK") {
                result := "UC K" . Trim(SubStr(partnumber, 3))
                newdescription := description
            }
            else if (SubStr(partnumber, 1, 3) = "TES") {
                result := "UC ES" . Trim(SubStr(partnumber, 4))
                newdescription := description
            }
            else if (SubStr(description, 1, 20) = "PROFUSION Brake Disc") {
                
                result := interchange("trsToASRotors.json", partnumber)


                if (result = "") {
                    result := linecode . " " . partnumber
                    newdescription := description
                } else {
                    newdescription := description
                }

            }
            else if (SubStr(description, 1, 18) = "BREMSEN Brake Disc"){
                ;MsgBox, The description is: ***%description%***  and sbustring is . SubStr(description, 1, 18)
                result := "BRM " . partnumber
                newdescription := description


            }
            else if (SubStr(description, 1, 26) = "BLACK BELT Serpentine Belt"){
                result := "SB 5" . SubStr(partnumber, 2)
                newdescription := "Serpentine Belt"

            }
            else {

                result := linecode . " " . partnumber
                newdescription := description

            }

        }


    }
    else if (warehouse = "Proforce"){

        ;MsgBox("It is Proforce")
        if (SubStr(partnumber, 1, 3) = "CRD") {
                result := "CRD " . Trim(SubStr(partnumber, 4))
                newdescription := "PROFORCE Ceramic Disc Pads"  ; Set the new description
        }
        else if (linecode = "ROT"){

            asrNumber := interchange("trsToASRotors.json", partnumber)
            result := linecode . " " . partnumber
            if (result = "") {

                newdescription := "BRAKE ROTORS"
            } else {
                newdescription :=  "BRAKE ROTORS - " . asrNumber
            }


        }
        else{
            result := linecode . " " . partnumber
            newdescription := description
        }






    }
        ;    else if (warehouse = "BestBuy"){
        ;
        ;    }
        ;    else if(warehouse = "CBK"){
        ;      result := linecode . " " . partnumber
        ;      newdescription := description
        ;
        ;   }
    else {
        result := linecode . " " . partnumber
        newdescription := description

    }

    resultList := []
    resultList.Push(result)
    resultList.Push(newdescription)
    ;resultList.Push(newPrice)
    ;resultList.Push(new)

    ; Return the array containing result and newdescription
    return resultList
}