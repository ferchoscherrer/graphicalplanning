import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import { MaintenanceOrder, SAPOrder } from "../model/types";
import Filter from "sap/ui/model/Filter"
import FilterOperator from "sap/ui/model/FilterOperator";
import MessageBox from "sap/m/MessageBox";
import ERP from "../modules/ERP"; 
import DateRangeSelection from "sap/m/DateRangeSelection";
import MessageToast from "sap/m/MessageToast";
import Button from "sap/m/Button";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import MessageView from "sap/m/MessageView";
import MessageItem from "sap/m/MessageItem";
import Dialog from "sap/m/Dialog";



/**
 * @namespace graphicalplanning.controller
 */
export default class Main extends Controller {

    private oDataModel: any; // Tu ODataModel principal
    private _aPendingChanges: any[] = [];
    private ZCS_RESCHEDULE_WORKORDER_SRV: ODataModel;
    private oRescheduleModel: any;
    private _resetUI(): void {
    const oBtnSave = this.byId("btnSave") as Button;
    const oBtnReset = this.byId("btnReset") as Button;
    
    if (oBtnSave) {
        oBtnSave.setEnabled(false);
        oBtnSave.setText("Guardar Cambios");
    }
    
    if (oBtnReset) {
        oBtnReset.setEnabled(false);
    }
}
/*
    public onInit(): void {
        const today = new Date();
        const dStart = new Date(today.getFullYear(), today.getMonth(), 1);

        const oViewModel = new JSONModel({
            startDateProject: new Date(new Date().getFullYear(), 0, 1),
            orders: [],
            isBusy: false
        });
        this.getView()!.setModel(oViewModel, "plan");
        this.oDataModel = this.getOwnerComponent()!.getModel();
        this._loadDashboardData();

        const oData = {
    startDateProject: dStart,
    orders: [
        { 
            id: "1001", 
            desc: "Falla Motor", 
            start: new Date(today.getFullYear(), today.getMonth(), 2), 
            end: new Date(today.getFullYear(), today.getMonth(), 3), // +1 día
            status: "completed", 
            technician: "Juan Pérez" 
        },
        { 
            id: "1002", 
            desc: "Lubricación", 
            start: new Date(today.getFullYear(), today.getMonth(), 4), 
            end: new Date(today.getFullYear(), today.getMonth(), 5), // +1 día
            status: "in_progress", 
            technician: "Juan Pérez" 
        },
        { 
            id: "1003", 
            desc: "Ajuste Frenos", 
            start: new Date(today.getFullYear(), today.getMonth(), 6), 
            end: new Date(today.getFullYear(), today.getMonth(), 7), // +1 día
            status: "pending", 
            technician: "Ricardo Sosa" 
        },
        { 
            id: "1004", 
            desc: "Electrónica", 
            start: new Date(today.getFullYear(), today.getMonth(), 8), 
            end: new Date(today.getFullYear(), today.getMonth(), 9), // +1 día
            status: "pending", 
            technician: "Ricardo Sosa" 
        }
    ]
};
this.getView()!.setModel(new JSONModel(oData), "plan");
    }
*/


public onInit(): void {
    // 1. Calcular fechas por defecto (Mes en curso)
    const oNow = new Date();
    const oFirstDay = new Date(oNow.getFullYear(), oNow.getMonth(), 1);
    const oLastDay = new Date(oNow.getFullYear(), oNow.getMonth() + 1, 0);

    // 2. Inicializar el modelo local "plan" con fechas iniciales
    const oViewModel = new JSONModel({
        startDateProject: oFirstDay,
        orders: [],
        isBusy: true
    });
    this.getView()!.setModel(oViewModel, "plan");
    this.getView()!.setBusyIndicatorDelay(0);

    // 3. Configurar el DateRangeSelection en la UI
    // Usamos un pequeño delay o esperamos a que la vista esté lista para asegurar que el ID exista
    this.getView()!.addEventDelegate({
        onAfterShow: () => {
            const oRangeSelection = this.byId("rangeSelection") as any;
            if (oRangeSelection) {
                oRangeSelection.setDateValue(oFirstDay);
                oRangeSelection.setSecondDateValue(oLastDay);
            }
        }
    });

    // 4. Obtener el modelo OData del Componente
    const oComponent = this.getOwnerComponent();
    if (oComponent) {
        this.oDataModel = oComponent.getModel();
        this.oRescheduleModel = oComponent.getModel("reschedule");
    }

    // 5. Carga inicial de datos
    if (this.oDataModel) {
        this._loadDashboardData();
    } else {
        // Salvavidas: Si el modelo no está listo (carga asíncrona del manifest)
        const oView = this.getView()!;
        const fnChange = () => {
            const oModel = this.getOwnerComponent()?.getModel();
            if (oModel) {
                this.oDataModel = oModel;
                this._loadDashboardData();
                oView.detachModelContextChange(fnChange); // Limpiar evento una vez obtenido
            }
        };
        oView.attachModelContextChange(fnChange);
    }
}
private async _loadDashboardData(): Promise<void> {
    const oView = this.getView();
    const oRange = this.byId("rangeSelection") as any; 
    
    if (!oView || !this.oDataModel || !oRange) return;

    // 1. Bloqueo total de la pantalla (UI) e indicador de carga
    oView.setBusy(true); 

    const oPlanModel = oView.getModel("plan") as JSONModel;
    oPlanModel.setProperty("/isBusy", true);

    // Obtener fechas del control UI
    let oStartDate = oRange.getDateValue();
    let oEndDate = oRange.getSecondDateValue();

    if (!oStartDate || !oEndDate) {
        oStartDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        oEndDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);
    } else {
        oStartDate.setHours(0, 0, 0, 0);
        oEndDate.setHours(23, 59, 59, 999);
    }

    oPlanModel.setProperty("/startDateProject", oStartDate);

    try {
        const aFilters = [
            new Filter("StartDate", FilterOperator.BT, oStartDate),
            new Filter("FinishDate", FilterOperator.BT, oEndDate)
        ];

        // 2. Llamada al ERP
        const oResponse = await ERP.getDataERP("/WorkOrderHeaderSet", this.oDataModel, aFilters);
        
        if (oResponse?.data?.results) {
            const aMappedOrders: MaintenanceOrder[] = oResponse.data.results.map((sapItem: any) => {
                const dStartRaw = new Date(sapItem.StartDate);
                const dEndRaw = new Date(sapItem.FinishDate);
                const dStart = new Date(dStartRaw.getTime() + dStartRaw.getTimezoneOffset() * 60000);
                const dEnd = new Date(dEndRaw.getTime() + dEndRaw.getTimezoneOffset() * 60000);
                
                dStart.setHours(0, 0, 0, 0);
                dEnd.setHours(0, 0, 0, 0);
                
                const sNombre = sapItem.NombreMec || "Sin Asignar";
                const sIdMecanico = sapItem.IdMecanico || "";
                const sTechnicianFull = sIdMecanico ? `${sNombre} (${sIdMecanico})` : sNombre;
                const sCleanId = (sapItem.Orderid || sapItem.Aufnr || "").replace(/^0+/, "");

                return {
                    id: sCleanId,
                    desc: sapItem.Description || sapItem.Ktext,
                    start: dStart,
                    end: dEnd,
                    status: this._mapFinalStatus(sapItem.SysStatus || "", sapItem.Userstatus || ""),
                    technician: sTechnicianFull,
                    equipment: sapItem.Equipment || sapItem.Equnr || "N/A",
                    customerName: sapItem.NombreCliente || sapItem.Name1 || "Sin Cliente"
                };
            });

            oPlanModel.setProperty("/orders", aMappedOrders);
            this._renderCustomGantt();
        }
    } catch (oError) {
        console.error("Error en la petición:", oError);
        MessageBox.error("No se pudo conectar con el servicio de órdenes.");
    } finally {
        // 3. Desbloqueo de la pantalla
        oPlanModel.setProperty("/isBusy", false);
        oView.setBusy(false);
    }
}

private _mapStatus(sStatus: string): string {
    if (!sStatus) return "status-default";

    const sUpperStatus = sStatus.toUpperCase();

    // JERARQUÍA DE PRIORIDADES (De fin a inicio):
    
    // 1. Si ya está Concluida/Cerrada
   if (sUpperStatus.includes("ABIE")) {
        return "status-abie"; // Azul
    }
     if (sUpperStatus.includes("LIB")) {
        return "status-lib"; // Azul
    }
    return "status-default";
}

private _mapFinalStatus(sSysStatus: string, sUserStatus: string): string {
    const sUser = sUserStatus ? sUserStatus.trim() : "";
    const sSys = sSysStatus ? sSysStatus.toUpperCase() : "";

    // --- PRIORIDAD 1: Estatus de Usuario (Si NO está vacío) ---
    if (sUser !== "") {
        switch (sUser) {
            case "0100": return "status-u100"; // Pendiente
            case "0200": return "status-u200"; // En proceso
            case "0300": return "status-u300"; // Finalizada
            case "0400": return "status-u400"; // Pendiente firma
            default: return "status-default";
        }
    }

    // --- PRIORIDAD 2: Estatus de Sistema (Si UserStatus está vacío) ---
    if (sSys.includes("ABIE")) return "status-abie"; // Azul

    return "status-default";
}
    private _mCollapsedGroups: { [key: string]: boolean } = {};

    public onAfterRendering(): void {
        this._renderCustomGantt();
    }

    private _renderCustomGantt(): void {
    const oView = this.getView();
    if (!oView) return;

    const oContainer = document.getElementById("realGanttId");
    const oHeader = document.getElementById("ganttHeader");
    
    // 1. Validación y espera de renderizado del DOM
    if (!oContainer || !oHeader) {
        setTimeout(() => this._renderCustomGantt(), 200);
        return;
    }

    const oModel = oView.getModel("plan") as JSONModel;
    const aOrders = oModel.getProperty("/orders") as MaintenanceOrder[] || [];
    const dStartProject = oModel.getProperty("/startDateProject");
    const iDayWidth = 120;

    // 2. Limpiar contenedor y dibujar encabezado de fechas
    this._renderHeader(dStartProject);
    oContainer.innerHTML = "";

    // 3. Agrupación por mecánico
    const mGroups = aOrders.reduce((acc: any, order) => {
        const tech = order.technician || "Sin Asignar";
        if (!acc[tech]) acc[tech] = [];
        acc[tech].push(order);
        return acc;
    }, {});

    // 4. Dibujar Grupos y Barras
    Object.keys(mGroups).forEach(techName => {
        const isCollapsed = this._mCollapsedGroups[techName] || false;

        // Fila de encabezado de Mecánico
        const oTechHeader = document.createElement("div");
        oTechHeader.className = `gantt-tech-header ${isCollapsed ? 'collapsed' : ''}`;
        oTechHeader.innerHTML = `
            <span class="collapse-icon">▼</span>
            <span>👤 Mecánico: ${techName} (${mGroups[techName].length} órdenes)</span>
        `;

        oTechHeader.onclick = () => {
            this._mCollapsedGroups[techName] = !isCollapsed;
            this._renderCustomGantt(); 
        };

        oContainer.appendChild(oTechHeader);

        // Dibujar las órdenes de este mecánico
        mGroups[techName].forEach((oOrder: MaintenanceOrder) => {
    const oRow = document.createElement("div");
    oRow.className = "gantt-row-custom";
    
    if (isCollapsed) {
        oRow.classList.add("row-collapsed");
    }

    oRow.ondragover = (e) => e.preventDefault();
    oRow.ondrop = (e) => this._onDropOrder(e, techName);

    const iOffsetDays = this._getDaysDiff(dStartProject, oOrder.start);
    let iDurationDays = this._getDaysDiff(oOrder.start, oOrder.end);
    if (iDurationDays <= 0) iDurationDays = 1;

    const bHasPendingChanges = this._aPendingChanges && 
                               this._aPendingChanges.some(c => c.Orderid === oOrder.id.padStart(12, '0'));
    const oBar = document.createElement("div");
    
    // LÓGICA DE BLOQUEO: Si el estatus empieza con "status-u" (Estatus de usuario 100, 200, etc.)
    const bIsLocked = oOrder.status.startsWith("status-u");
    oBar.className = `gantt-bar-custom ${oOrder.status} ${bIsLocked ? "order-locked" : ""} ${bHasPendingChanges ? "order-changed" : ""}`;
  //  oBar.className = `gantt-bar-custom ${oOrder.status} ${bIsLocked ? "order-locked" : ""}`;
    
    // Solo es arrastrable si NO está bloqueado
    oBar.draggable = !bIsLocked;
    
    // Solo adjuntamos eventos de Drag si no está bloqueado
    if (!bIsLocked) {
        this._attachDragEvents(oBar, oOrder, dStartProject, iDayWidth);
    } else {
        oBar.title = "Esta orden tiene un estatus de usuario y no se puede mover.";
        oBar.style.cursor = "not-allowed";
    }

    oBar.style.left = `${iOffsetDays * iDayWidth}px`;
    oBar.style.width = `${(iDurationDays * iDayWidth) - 2}px`;
    
    const sWarningIcon = oOrder.status === "status-abie" ? "⚠️ " : "";
    const sLockIcon = bIsLocked ? "🔒 " : "";

    oBar.innerHTML = `
        <div class="bar-id" style="pointer-events:none; font-size: 0.7rem; font-weight: bold; opacity: 0.9;">
             ${sLockIcon}${sWarningIcon}Orden: ${oOrder.id}
         </div>
        <div class="bar-equipment" style="pointer-events:none; font-size: 0.65rem;">EQ: ${(oOrder as any).equipment || "N/A"}</div>
        <div class="bar-customer" style="pointer-events:none; font-size: 0.65rem;">${(oOrder as any).customerName || "N/A"}</div>
    `;

    oRow.appendChild(oBar);
    oContainer.appendChild(oRow);
});
    });

    const oNow = new Date();
    // Solo dibujamos la línea si "Hoy" está dentro del mes visible
    if (oNow.getMonth() === dStartProject.getMonth() && oNow.getFullYear() === dStartProject.getFullYear()) {
        const iTodayOffset = this._getDaysDiff(dStartProject, oNow);
        
        // Calculamos la posición exacta incluyendo horas y minutos para que la línea se mueva durante el día
        const iExactOffset = iTodayOffset + (oNow.getHours() / 24) + (oNow.getMinutes() / 1440);
        
        const oTodayLine = document.createElement("div");
        oTodayLine.className = "gantt-today-line";
        oTodayLine.style.left = `${iExactOffset * iDayWidth}px`;
        
        // Añadimos una etiqueta que diga "Hoy"
        oTodayLine.innerHTML = `<span class="today-label">Hoy</span>`;
        
        oContainer.appendChild(oTodayLine);
        const oSearchField = this.byId("searchOrders") as any;
if (oSearchField && oSearchField.getValue()) {
    // Disparamos manualmente el filtro para aplicar sobre el nuevo DOM
    this.onSearchGantt({ getParameter: () => oSearchField.getValue() });
}
    }
}
    // ESTA ES LA FUNCIÓN QUE FALTABA
    private _attachDragEvents(oBar: HTMLElement, oOrder: MaintenanceOrder, dStartProject: Date, iDayWidth: number): void {
        let oTooltip = document.getElementById("gantt-tooltip");
        if (!oTooltip) {
            oTooltip = document.createElement("div");
            oTooltip.id = "gantt-tooltip";
            oTooltip.className = "gantt-tooltip";
            document.body.appendChild(oTooltip);
        }

        oBar.ondragstart = (e: DragEvent) => {
            if (e.dataTransfer) {
                e.dataTransfer.setData("orderId", oOrder.id);
                const rect = oBar.getBoundingClientRect();
                e.dataTransfer.setData("cursorOffsetX", (e.clientX - rect.left).toString());
            }
            if (oTooltip) oTooltip.style.display = "block";
        };

        oBar.ondrag = (e: DragEvent) => {
    if (e.clientX === 0 || !oTooltip) return;
    
    const cursorOffsetX = parseInt(e.dataTransfer?.getData("cursorOffsetX") || "0");
    const oContainer = document.getElementById("realGanttId");
    if (oContainer) {
        const rect = oContainer.getBoundingClientRect();
        const x = e.clientX - rect.left - cursorOffsetX;
        
        // CAMBIO: Usar floor para evitar el salto a mitad del día
        const dayOffset = Math.floor(x / iDayWidth); 
        
        const dTarget = new Date(dStartProject);
        dTarget.setDate(dStartProject.getDate() + dayOffset);

        oTooltip.innerHTML = `Mover a: <b>${dTarget.toLocaleDateString('es-ES')}</b>`;
        oTooltip.style.left = (e.clientX + 15) + "px";
        oTooltip.style.top = (e.clientY + 15) + "px";
    }
};

        oBar.ondragend = () => {
            if (oTooltip) oTooltip.style.display = "none";
        };
    }

   private _onDropOrder(e: DragEvent, newTechnician: string): void {
    e.preventDefault();
    const orderId = e.dataTransfer?.getData("orderId");
    if (!orderId) return;

    const oModel = this.getView()!.getModel("plan") as JSONModel;
    const aOrders = oModel.getProperty("/orders") as MaintenanceOrder[];
    const oOrder = aOrders.find(o => o.id === orderId);

    if (oOrder) {
        // --- 1. VALIDACIÓN DE BLOQUEO POR ESTATUS ---
        if (oOrder.status && oOrder.status.startsWith("status-u")) {
            MessageToast.show("No se puede mover: La orden ya tiene un estatus de gestión.");
            return;
        }

        const cursorOffsetX = parseInt(e.dataTransfer?.getData("cursorOffsetX") || "0");
        const oContainer = document.getElementById("realGanttId");
        if (!oContainer) return;

        const rect = oContainer.getBoundingClientRect();
        const iDayWidth = 120;
        
        // 2. CÁLCULOS DE POSICIÓN X RELATIVA
        const x = e.clientX - rect.left - cursorOffsetX;
        const newDayOffset = Math.floor((x + (iDayWidth / 2)) / iDayWidth);
        const dStartProject = oModel.getProperty("/startDateProject");
        
        // 3. CÁLCULO DE DURACIÓN ORIGINAL
        let durationDays = this._getDaysDiff(oOrder.start, oOrder.end);
        if (durationDays <= 0) durationDays = 1;

        // 4. ASIGNACIÓN DE NUEVAS FECHAS (Ajuste Anti-Desfase)
        // Usamos getTime() para clonar la fecha base y evitar mutaciones
        const newStart = new Date(dStartProject.getTime());
        newStart.setDate(dStartProject.getDate() + newDayOffset);
        
        /** * FIX CRÍTICO: Seteamos a las 12:00 PM. 
         * Si tu zona horaria (México) resta 6 horas al enviar a SAP, 
         * la fecha llegará como las 06:00 AM del MISMO DÍA en lugar de las 18:00 del día anterior.
         */
        newStart.setHours(12, 0, 0, 0);
        
        const newEnd = new Date(newStart.getTime());
        newEnd.setDate(newStart.getDate() + durationDays);
        newEnd.setHours(12, 0, 0, 0);

        // 5. ACTUALIZACIÓN DEL MODELO LOCAL
        oOrder.start = newStart;
        oOrder.end = newEnd;
        oOrder.technician = newTechnician;
        oModel.setProperty("/orders", aOrders);

        // --- 6. REGISTRO DE CAMBIOS PARA SAP (JSON PREVIEW) ---
        const oChange = {
            Orderid: oOrder.id.padStart(12, '0'),
            StartDate: newStart, 
            FinishDate: newEnd,
            IdMecanico: oOrder.technician 
        };

        if (!this._aPendingChanges) { this._aPendingChanges = []; }
        this._aPendingChanges = this._aPendingChanges.filter(c => c.Orderid !== oChange.Orderid);
        this._aPendingChanges.push(oChange);

        // Actualización visual del botón de guardar
        const oBtnSave = this.byId("btnSave") as Button;
        const oBtnReset = this.byId("btnReset") as Button;
        if (oBtnSave) {
            oBtnSave.setEnabled(true);
            oBtnSave.setText(`Guardar Cambios (${this._aPendingChanges.length})`);
        }
        if (oBtnReset) {
    oBtnReset.setEnabled(true);
}

        // 7. REFRESCAR GANTT
        this._renderCustomGantt();
        
        MessageToast.show(`Orden ${oOrder.id} preparada para el día ${newStart.getDate()}`);
        console.log("Cambio registrado (Safe Date):", oChange);
    }
}
public onResetChanges(): void {
    if (this._aPendingChanges.length === 0) return;

    MessageBox.confirm("¿Estás seguro de descartar todos los cambios realizados? Se perderán los movimientos no guardados.", {
        title: "Confirmar Descarte",
        actions: [MessageBox.Action.YES, MessageBox.Action.NO],
        onClose: (oAction: string | null) => {
            if (oAction === MessageBox.Action.YES) {
                // 1. Limpiar el arreglo de cambios
                this._aPendingChanges = [];

                // 2. Deshabilitar botones
                (this.byId("btnSave") as Button).setEnabled(false);
                (this.byId("btnSave") as Button).setText("Guardar");
                (this.byId("btnReset") as Button).setEnabled(false);

                // 3. Recargar datos originales de SAP
                this._loadDashboardData();
                
                MessageToast.show("Cambios descartados.");
            }
        }
    });
}

    private _renderHeader(dStart: Date): void {
    const oHeader = document.getElementById("ganttHeader");
    const oRange = this.byId("rangeSelection") as any;
    
    if (!oHeader || !oRange) return;

    oHeader.innerHTML = "";
    const iDayWidth = 120; // Regresamos al ancho estándar

    const dEnd = oRange.getSecondDateValue();
    let iTotalDays = 31;
    if (dEnd) {
        iTotalDays = this._getDaysDiff(dStart, dEnd) + 1;
    }

    const sTotalWidth = `${iTotalDays * iDayWidth}px`;
    oHeader.style.width = sTotalWidth;
    
    const oGanttMaster = document.getElementById("realGanttId");
    if (oGanttMaster) oGanttMaster.style.width = sTotalWidth;

    for (let i = 0; i < iTotalDays; i++) {
        const dCurrent = new Date(dStart);
        dCurrent.setDate(dStart.getDate() + i);
        
        const oDayBox = document.createElement("div");
        oDayBox.className = "header-day";
        oDayBox.style.width = `${iDayWidth}px`;

        // 1. Lógica de MES (Se mantiene igual)
        let sMonthLabel = "";
        if (dCurrent.getDate() === 1 || i === 0) {
            const sMonthName = dCurrent.toLocaleDateString('es-ES', { month: 'long' }).toUpperCase();
            sMonthLabel = `<div class="month-indicator">${sMonthName} ${dCurrent.getFullYear()}</div>`;
        }

        // 2. Lógica de SEMANA: Si es Lunes (1) o el inicio del reporte
        let sWeekLabel = "";
        if (dCurrent.getDay() === 1 || i === 0) {
            const iWeekNum = this._getWeekNumber(dCurrent);
            sWeekLabel = `<div class="week-indicator">Sem. ${iWeekNum}</div>`;
        }
        
        // Resaltar fines de semana
        const iDayOfWeek = dCurrent.getDay();
        if (iDayOfWeek === 0 || iDayOfWeek === 6) {
            oDayBox.classList.add("weekend");
        }

        oDayBox.innerHTML = `
            ${sMonthLabel}
            ${sWeekLabel}
            <span class="day-num">${dCurrent.getDate()}</span>
            <span class="day-name">${dCurrent.toLocaleDateString('es-ES', { weekday: 'short' })}</span>
        `;
        
        oHeader.appendChild(oDayBox);
    }
}

private _formatDateSAP(oDate: Date): string {
    const y = oDate.getFullYear();
    const m = ("0" + (oDate.getMonth() + 1)).slice(-2);
    const d = ("0" + oDate.getDate()).slice(-2);
    return `${y}${m}${d}`;
}

public async onSaveSAP(): Promise<void> {
    if (this._aPendingChanges.length === 0) return;

    // 1. Bloqueo total de la pantalla (UI)
    const oView = this.getView()!;
    oView.setBusy(true); 

    const oPlanModel = oView.getModel("plan") as JSONModel;
    oPlanModel.setProperty("/isBusy", true);

    const oPayload = {
        "WorkOrderHeader": { "Supervisor": "miguel.hernandez@tellus-technologies.com" },
        "WorkOrderItemsSet": this._aPendingChanges.map(change => {
            let sMecId = "";
            const sOriginalMec = change.IdMecanico || "";
            if (sOriginalMec !== "" && sOriginalMec !== "Sin Asignar") {
                const oMatch = sOriginalMec.match(/\(([^)]+)\)/);
                sMecId = oMatch ? oMatch[1] : sOriginalMec;
            }
            return {
                "OrderId": change.Orderid,
                "OrderItem": "",
                "FechaIni": this._formatDateSAP(change.StartDate),
                "FechaFin": this._formatDateSAP(change.FinishDate),
                "Mecanico": sMecId
            };
        }),
        "ReturnSet": []
    };

    try {
        // 2. Guardamos la lista de IDs modificados antes de limpiar el arreglo
        const aModifiedIds = this._aPendingChanges.map(o => o.Orderid.replace(/^0+/, ""));
        const sOrdersList = aModifiedIds.join(", ");

        // 3. LLAMADA POST AL ERP
        const oResponse: any = await ERP.createDataERP("/WorkOrderHeaderSet", this.oRescheduleModel, oPayload);

        // 4. MOSTRAR RESULTADOS
        if (oResponse && oResponse.ReturnSet && oResponse.ReturnSet.results && oResponse.ReturnSet.results.length > 0) {
            // Si SAP devolvió mensajes detallados, usamos el diálogo profesional
            this._showSapReturnMessages(oResponse.ReturnSet.results);
        } else {
            // Si no hay mensajes de error, mostramos un resumen de éxito
            MessageBox.success(`Se actualizaron correctamente las siguientes órdenes: \n\n ${sOrdersList}`, {
                title: "Cambios Guardados"
            });
        }

        // 5. LIMPIEZA Y REFRESCO
        this._aPendingChanges = [];
        this._resetUI();
        await this._loadDashboardData();

    } catch (oError: any) {
        console.error("Error SAP:", oError);
        MessageBox.error("No se pudieron guardar los cambios. Revise la consola.");
    } finally {
        // 6. DESBLOQUEO DE PANTALLA
        oPlanModel.setProperty("/isBusy", false);
        oView.setBusy(false);
    }
}

private _showSapReturnMessages(aReturnSet: any[]): void {
    if (!aReturnSet || aReturnSet.length === 0) return;

    const aMessageItems = aReturnSet.map(msg => {
        let sType: any = "Information";
        if (msg.Type === "E") sType = "Error";
        if (msg.Type === "S") sType = "Success";
        if (msg.Type === "W") sType = "Warning";

        return new MessageItem({
            type: sType,
            title: msg.Message || "Sin mensaje",
            subtitle: msg.Id ? `Clase: ${msg.Id} - Nº: ${msg.Number}` : "",
            description: `Orden: ${msg.MessageV1 || "N/A"}`
        });
    });

    const oMessageView = new MessageView({ items: aMessageItems });

    const oDialog = new Dialog({
        title: "Respuesta del Sistema SAP",
        content: oMessageView,
        beginButton: new Button({
            text: "Cerrar",
            press: () => oDialog.close()
        }),
        contentHeight: "400px",
        contentWidth: "500px",
        verticalScrolling: true
    });

    oDialog.open();
}

// Función auxiliar para obtener el número de semana
private _getWeekNumber(d: Date): number {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

    private _getDaysDiff(startDate: Date, endDate: Date): number {
    const diffInMs = endDate.getTime() - startDate.getTime();
    // Para el offset de la línea usamos floor para obtener días transcurridos exactos
    return Math.floor(diffInMs / (1000 * 60 * 60 * 24));
}

public onSearchGantt(oEvent: any): void {
    const sQuery = oEvent.getParameter("newValue").toLowerCase();
    const oContainer = document.getElementById("realGanttId");
    if (!oContainer) return;

    // Obtenemos todas las filas de órdenes
    const aRows = oContainer.getElementsByClassName("gantt-row-custom");

    for (let i = 0; i < aRows.length; i++) {
        const oRow = aRows[i] as HTMLElement;
        const oBar = oRow.querySelector(".gantt-bar-custom") as HTMLElement;
        
        if (!oBar) continue;

        // Extraemos el texto de la barra para comparar (ID, Equipo, Cliente)
        const sContent = oBar.innerText.toLowerCase();

        if (sContent.includes(sQuery)) {
            // Si coincide, mostramos la fila con opacidad normal
            oRow.style.display = "flex";
            oBar.style.opacity = "1";
            if (sQuery !== "") {
                oBar.style.boxShadow = "0 0 15px #ccff00"; // Brillo especial si hay búsqueda activa
            } else {
                oBar.style.boxShadow = "none";
            }
        } else {
            // Si no coincide, podemos ocultar la fila o bajar la opacidad
            // Opción A: Ocultar completamente
            oRow.style.display = "none";
            
            // Opción B: Mostrar tenue (si prefieres no mover el scroll)
            // oRow.style.opacity = "0.1"; 
        }
    }

    // También debemos manejar los encabezados de los técnicos
    this._updateTechHeadersVisibility();
}

/**
 * Oculta los encabezados de mecánicos que no tengan órdenes visibles
 */
private _updateTechHeadersVisibility(): void {
    const aHeaders = document.getElementsByClassName("gantt-tech-header");
    for (let i = 0; i < aHeaders.length; i++) {
        const oHeader = aHeaders[i] as HTMLElement;
        let oNextElement = oHeader.nextElementSibling as HTMLElement;
        let bHasVisibleOrders = false;

        // Revisamos las filas siguientes hasta el próximo encabezado
        while (oNextElement && !oNextElement.classList.contains("gantt-tech-header")) {
            if (oNextElement.style.display !== "none") {
                bHasVisibleOrders = true;
                break;
            }
            oNextElement = oNextElement.nextElementSibling as HTMLElement;
        }

        oHeader.style.display = bHasVisibleOrders ? "flex" : "none";
    }
}
}