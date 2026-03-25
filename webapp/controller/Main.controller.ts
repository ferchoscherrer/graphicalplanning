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

    // *** NUEVO: Referencia para controlar el evento de navegación correctamente ***
    private _fnNavigationHandler: any;

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

public onInit(): void {
    
    // 1. Calcular fechas por defecto (Mes en curso)
    const oNow = new Date();
    const oFirstDay = new Date(oNow.getFullYear(), oNow.getMonth(), 1);
    const oLastDay = new Date(oNow.getFullYear(), oNow.getMonth() + 1, 0);

    // 2. Inicializar el modelo local "plan" con fechas iniciales y retardo de Busy a 0
    const oViewModel = new JSONModel({
        startDateProject: oFirstDay,
        orders: [],
        isBusy: true,
        // *** CAMBIO: Inicialización de la estructura de resumen para los contadores ***
        summary: { u100: 0, u200: 0, u300: 0, u400: 0, abie: 0, others: 0, changed: 0,
            // NUEVO: Arreglos vacíos para los MicroCharts
            supervisors: [],
            mecanicos: [],
            zonas: []
         }
    });
    this.getView()!.setModel(oViewModel, "plan");
    this.getView()!.setBusyIndicatorDelay(0);

    // 3. Configurar el DateRangeSelection en la UI (onAfterShow)
    this.getView()!.addEventDelegate({
        onAfterShow: () => {
            const oRangeSelection = this.byId("rangeSelection") as any;
            if (oRangeSelection) {
                oRangeSelection.setDateValue(oFirstDay);
                oRangeSelection.setSecondDateValue(oLastDay);
            }
            console.log("GanttLog: Registrando estado de protección en historial");
            window.history.pushState({ protected: true }, "", window.location.href);
        }
    });

    // 4. Obtener el Componente y registrar modelos/eventos
    const oComponent = this.getOwnerComponent();
    if (oComponent) {
        // Modelos OData
        this.oDataModel = oComponent.getModel();
        this.oRescheduleModel = oComponent.getModel("reschedule");
        console.log("GanttLog: Registrando listeners de salida");

        // *** CAMBIO: Registro de eventos de salida con referencia persistente ***
        this._fnNavigationHandler = this._handleBrowserBack.bind(this);
        window.addEventListener("popstate", this._fnNavigationHandler);
        
        window.addEventListener("beforeunload", this._handleBeforeUnload.bind(this));
    }

    // 5. Carga inicial de datos
    if (this.oDataModel) {
        this._loadDashboardData();
    } else {
        // Salvavidas: Si el modelo no está listo aún (carga asíncrona)
        const oView = this.getView()!;
        const fnChange = () => {
            const oModel = this.getOwnerComponent()?.getModel();
            if (oModel) {
                this.oDataModel = oModel;
                this._loadDashboardData();
                oView.detachModelContextChange(fnChange);
            }
        };
        oView.attachModelContextChange(fnChange);
    }
    this.getView()!.bindElement({
    path: "plan>/"
});
}

public onExit(): void {
    console.log("GanttLog: Limpiando listeners en onExit");
    window.removeEventListener("popstate", this._fnNavigationHandler);
    window.removeEventListener("beforeunload", this._handleBeforeUnload.bind(this));
}

// *** NUEVO MÉTODO: Bloqueo de cierre de pestaña o recarga (F5) ***
private _handleBeforeUnload(oEvent: BeforeUnloadEvent): void {
    if (this._aPendingChanges && this._aPendingChanges.length > 0) {
        oEvent.preventDefault();
        oEvent.returnValue = ''; 
    }
}


private _handleBrowserBack(oEvent: any): void {
    if (this._aPendingChanges && this._aPendingChanges.length > 0) {
        console.log("GanttLog: Intento de salida con cambios ->", this._aPendingChanges.length);

        // 1. Inmediatamente volvemos a poner el estado para evitar que el Router de SAPUI5 reaccione
        window.history.pushState({ protected: true }, "", window.location.href);

        // 2. Mostrar confirmación
        MessageBox.confirm("Tienes movimientos pendientes en el Gantt. ¿Estás seguro de que deseas salir? Los cambios se perderán.", {
            title: "Confirmar salida",
            actions: [MessageBox.Action.YES, MessageBox.Action.NO],
            onClose: (oAction: string | null) => {
                if (oAction === MessageBox.Action.YES) {
                    console.log("GanttLog: Usuario confirmó salida.");
                    this._aPendingChanges = [];
                    // Removemos el listener para que el siguiente back() no sea interceptado
                    window.removeEventListener("popstate", this._fnNavigationHandler);
                    window.history.back(); // Ahora sí sale de la app
                } else {
                    console.log("GanttLog: Usuario canceló salida. Permaneciendo en Gantt.");
                    MessageToast.show("Edición mantenida.");
                }
            }
        });
    }
}

// *** NUEVO MÉTODO: Lógica de conteo para el dashboard dinámico ***
private _updateOrderSummary(): void {
    const oView = this.getView();
    if (!oView) return;

    const oPlanModel = oView.getModel("plan") as JSONModel;
    const aOrders = oPlanModel.getProperty("/orders") || [];
    
    // 1. Obtenemos el objeto summary actual para NO borrar lo que ya tiene (como supervisors)
    const oCurrentSummary = oPlanModel.getProperty("/summary") || {};

    // 2. Creamos los nuevos contadores
    const oNewCounters = {
        u100: 0, u200: 0, u300: 0, u400: 0, abie: 0, others: 0,
        changed: (this as any)._aPendingChanges ? (this as any)._aPendingChanges.length : 0
    };

    aOrders.forEach((oOrder: any) => {
        switch (oOrder.status) {
            case "status-u100": oNewCounters.u100++; break;
            case "status-u200": oNewCounters.u200++; break;
            case "status-u300": oNewCounters.u300++; break;
            case "status-u400": oNewCounters.u400++; break;
            case "status-abie": oNewCounters.abie++; break;
            default: oNewCounters.others++; break;
        }
    });

    // 3. MERGE: Combinamos los contadores nuevos con los datos existentes (supervisors, etc.)
    const oFinalSummary = Object.assign({}, oCurrentSummary, oNewCounters);

    // 4. Seteamos el objeto completo sin destruir las otras propiedades
    oPlanModel.setProperty("/summary", oFinalSummary);
    
    console.log("GanttLog: Resumen actualizado respetando MicroCharts", oFinalSummary);
}

private async _loadDashboardData(): Promise<void> {
    const oView = this.getView();
    const oRange = this.byId("rangeSelection") as any; 
    
    if (!oView || !this.oDataModel || !oRange) return;

    oView.setBusy(true); 

    const sEmail = (sap as any).ushell?.Container?.getService("UserInfo")?.getUser()?.getEmail() 
                   || "sapmelmex@melco.com.mx";
    const oPlanModel = oView.getModel("plan") as JSONModel;
    oPlanModel.setProperty("/isBusy", true);

    let oStartDate = oRange.getDateValue();
    let oEndDate = oRange.getSecondDateValue();

    if (!oStartDate || !oEndDate) {
        oStartDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        oEndDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);
    } else {
        oStartDate.setHours(0, 0, 0, 0);
        oEndDate.setHours(0, 0, 0, 0); // <--- CAMBIO: Asegurar fin de día para el filtro
    }

    oPlanModel.setProperty("/startDateProject", oStartDate);

    try {
        const aFilters = [
            new Filter("Userstatus", FilterOperator.EQ, sEmail),
            new Filter("StartDate", FilterOperator.BT, oStartDate),
            new Filter("FinishDate", FilterOperator.BT, oEndDate)
        ];

        const oResponse = await ERP.getDataERP("/WorkOrderHeaderSet", this.oDataModel, aFilters);
        
        if (oResponse?.data?.results) {
            const aRawResults = oResponse.data.results;
            const aFilteredResults = aRawResults.filter((item: any) => {
                const sType = item.OrderType || item.Auart || "";
                return sType.toUpperCase() === "SM02";
            });

            // 1. Mapeo de órdenes (Mantenemos tu lógica)
            const aMappedOrders: MaintenanceOrder[] = aFilteredResults.map((sapItem: any) => {
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

            // 2. Actualizar órdenes primero
            oPlanModel.setProperty("/orders", aMappedOrders);
            
            // 3. PROCESAMIENTO DE MICROCHARTS <--- CAMBIO: Se ejecuta DESPUÉS de tener aMappedOrders
            // Pasamos aFilteredResults para tener acceso a Userstatus original
            this._computeSupervisorStats(aFilteredResults); 
            this._computeMecanicoStats(aFilteredResults);
            this._computeZonaStats(aFilteredResults);

            // 4. Actualización de contadores y Gantt
            this._updateOrderSummary();
            this._renderCustomGantt();
        }
    } catch (oError) {
        console.error("Error en la carga de datos:", oError);
        MessageBox.error("No se pudo conectar con el servicio de órdenes SAP.");
    } finally {
        oPlanModel.setProperty("/isBusy", false);
        oView.setBusy(false);
    }
}

/**
 * NUEVA FUNCIÓN: Procesa estadísticas de supervisores basándose en los resultados de SM02
 */
/**
 * Procesa estadísticas de supervisores basándose en los resultados de SM02
 */
private _computeSupervisorStats(aFilteredResults: any[]): void {
    const oView = this.getView();
    if (!oView) return;

    const oPlanModel = oView.getModel("plan") as any;
    const mGroups: any = {};
    
    // Arreglo auxiliar para el log de auditoría
    const aAuditLog: any[] = [];

    // 1. Agrupamos por supervisor y auditamos el estatus
    aFilteredResults.forEach(oItem => {
        const sName = oItem.NombreSup || oItem.Supervisor || "Sin Asignar";
        const sOrderId = oItem.Orderid || oItem.Aufnr || "S/N";
        const sStatus = oItem.Userstatus || "";

        if (!mGroups[sName]) {
            mGroups[sName] = { total: 0, completed: 0 };
        }
        
        mGroups[sName].total++;
        
        // Lógica de completado
        const bIsCompleted = (sStatus === "0300" || sStatus === "U300");
        
        if (bIsCompleted) {
            mGroups[sName].completed++;
        }

        // Guardamos en el log de auditoría para el console.log
        aAuditLog.push({
            Supervisor: sName,
            Orden: sOrderId,
            StatusOriginal: sStatus,
            EsCompletada: bIsCompleted ? "SÍ" : "NO"
        });
    });

    // --- CONSOLE LOG DE AUDITORÍA ---
    console.log("GanttLog: Detalle de procesamiento de órdenes para MicroChart:");
    console.table(aAuditLog); 

    // 2. Mapeamos al formato del Chart
    const aData = Object.keys(mGroups).map((sKey) => {
        const iTotal = mGroups[sKey].total;
        const iCompleted = mGroups[sKey].completed;
        const iRealPercent = Math.round((iCompleted / iTotal) * 100) || 0;

        return {
            Title: String(sKey),
            Value: Number(iRealPercent),
            Color: iRealPercent >= 75 ? "Good" : (iRealPercent >= 40 ? "Critical" : "Error")
        };
    })

    // 3. Actualizamos modelo
    oPlanModel.setProperty("/summary/supervisors", aData);
   // this._forceChartHeight("supervisorChart", aData.length);

    // 4. Forzamos refresco visual
    setTimeout(() => {
        const oChart = oView.byId("supervisorChart") as any;
        if (oChart) {
            const oBinding = oChart.getBinding("data");
            if (oBinding) oBinding.refresh(true);
            oChart.invalidate(); 
        }
    }, 300);
}

private _computeMecanicoStats(aFilteredResults: any[]): void {
    const oView = this.getView();
    if (!oView) return;

    const oPlanModel = oView.getModel("plan") as any;
    const mGroups: any = {};
    const aAuditLog: any[] = [];

    aFilteredResults.forEach(oItem => {
        // Usamos NombreMec o el campo que identifique al técnico
        const sName = oItem.NombreMec || oItem.Technician || "Sin Asignar";
        const sOrderId = oItem.Orderid || oItem.Aufnr || "S/N";
        const sStatus = oItem.Userstatus || "";

        if (!mGroups[sName]) {
            mGroups[sName] = { total: 0, completed: 0 };
        }
        
        mGroups[sName].total++;
        
        const bIsCompleted = (sStatus === "0300" || sStatus === "U300");
        if (bIsCompleted) {
            mGroups[sName].completed++;
        }

        aAuditLog.push({
            Mecanico: sName,
            Orden: sOrderId,
            Status: sStatus,
            EsCompletada: bIsCompleted ? "SÍ" : "NO"
        });
    });

    console.log("GanttLog: Detalle Mecánicos:");
    console.table(aAuditLog);

    const aData = Object.keys(mGroups).map((sKey) => {
        const iTotal = mGroups[sKey].total;
        const iCompleted = mGroups[sKey].completed;
        const iRealPercent = Math.round((iCompleted / iTotal) * 100) || 0;

        return {
            Title: String(sKey),
            Value: Number(iRealPercent),
            // Color según desempeño del mecánico
            Color: iRealPercent >= 80 ? "Good" : (iRealPercent >= 50 ? "Critical" : "Error")
        };
    }) // Aquí NO filtramos por Value > 0 para que veas a todos los mecánicos asignados
    .sort((a, b) => b.Value - a.Value); // Orden descendente (Mayor a Menor)

    // Guardamos en la propiedad 'mecanicos' que definiste en el onInit
    oPlanModel.setProperty("/summary/mecanicos", aData);
    //this._forceChartHeight("mecanicosChart", aData.length);

    setTimeout(() => {
        const oChart = oView.byId("mecanicosChart") as any;
        if (oChart) {
            oChart.getBinding("data")?.refresh(true);
            oChart.invalidate(); 
        }
    }, 300);
}

private _computeZonaStats(aFilteredResults: any[]): void {
    const oView = this.getView();
    if (!oView) return;

    const oPlanModel = oView.getModel("plan") as any;
    const mGroups: any = {};
    const aAuditLog: any[] = [];

    aFilteredResults.forEach(oItem => {
        // AJUSTE: Usa el campo que represente la Zona/Emplazamiento en tu OData
        const sName = oItem.Base || oItem.Zona || "Sin Zona";
        const sOrderId = oItem.Orderid || oItem.Aufnr || "S/N";
        const sStatus = oItem.Userstatus || "";

        if (!mGroups[sName]) {
            mGroups[sName] = { total: 0, completed: 0 };
        }
        
        mGroups[sName].total++;
        
        const bIsCompleted = (sStatus === "0300" || sStatus === "U300");
        if (bIsCompleted) {
            mGroups[sName].completed++;
        }

        aAuditLog.push({
            Zona: sName,
            Orden: sOrderId,
            Status: sStatus,
            EsCompletada: bIsCompleted ? "SÍ" : "NO"
        });
    });

    console.log("GanttLog: Detalle Zonas:");
    console.table(aAuditLog);

    const aData = Object.keys(mGroups).map((sKey) => {
        const iTotal = mGroups[sKey].total;
        const iCompleted = mGroups[sKey].completed;
        const iRealPercent = Math.round((iCompleted / iTotal) * 100) || 0;

        return {
            Title: String(sKey),
            Value: Number(iRealPercent),
            Color: iRealPercent >= 80 ? "Good" : (iRealPercent >= 50 ? "Critical" : "Error")
        };
    });

    oPlanModel.setProperty("/summary/zonas", aData);
    //this._forceChartHeight("zonasChart", aData.length);

    setTimeout(() => {
        const oChart = oView.byId("zonasChart") as any;
        if (oChart) {
            oChart.getBinding("data")?.refresh(true);
            oChart.invalidate(); 
        }
    }, 300);
}

private _forceChartHeight(sId: string, iCount: number): void {
    setTimeout(() => {
        const oChart = this.getView()!.byId(sId) as any;
        if (oChart) {
            // 55px es un buen alto para que la barra y el texto respiren
            const iMinHeight = iCount * 55; 
            oChart.setHeight(iMinHeight + "px");
            
            const oBinding = oChart.getBinding("data");
            if (oBinding) {
                oBinding.refresh(true);
            }
        }
    }, 300);
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
    const aOrders = oModel.getProperty("/orders") || [];
    const dStartProject = oModel.getProperty("/startDateProject");
    const iDayWidth = 120;

    // 2. Limpiar contenedor y dibujar encabezado de fechas
    this._renderHeader(dStartProject);
    oContainer.innerHTML = "";

    // 3. Agrupación por mecánico
    const mGroups = aOrders.reduce((acc: any, order: MaintenanceOrder) => {
        const tech = order.technician || "Sin Asignar";
        if (!acc[tech]) acc[tech] = [];
        acc[tech].push(order);
        return acc;
    }, {});

    // --- LÓGICA DE ORDENAMIENTO: Mandar "Sin Asignar" al final ---
    const aSortedTechNames = Object.keys(mGroups).sort((a, b) => {
        const sNameA = a.toLowerCase();
        const sNameB = b.toLowerCase();

        if (sNameA.includes("sin asignar")) return 1;
        if (sNameB.includes("sin asignar")) return -1;

        return sNameA.localeCompare(sNameB);
    });

    // 4. Dibujar Grupos y Barras
    aSortedTechNames.forEach(techName => {
        const isCollapsed = this._mCollapsedGroups[techName] || false;
        const bIsUnassigned = techName.toLowerCase().includes("sin asignar");
        
        // *** NUEVO: Calcular resumen de estados para este mecánico específico ***
        const aOrdersByTech = mGroups[techName];
        const oT = { u100: 0, u200: 0, u300: 0, u400: 0, abie: 0 };
        
        aOrdersByTech.forEach((o: any) => {
            if (o.status === "status-u100") oT.u100++;
            else if (o.status === "status-u200") oT.u200++;
            else if (o.status === "status-u300") oT.u300++;
            else if (o.status === "status-u400") oT.u400++;
            else if (o.status === "status-abie") oT.abie++;
        });

        // Fila de encabezado de Mecánico
        const oTechHeader = document.createElement("div");
        oTechHeader.className = `gantt-tech-header ${isCollapsed ? 'collapsed' : ''}`;
        
        // --- COLOR DIFERENTE PARA SIN ASIGNAR ---
        if (bIsUnassigned) {
            oTechHeader.style.backgroundColor = "#ff9500ff"; // Gris azulado oscuro
            oTechHeader.style.borderLeft = "5px solid #ff9800"; // Borde naranja de advertencia
            oTechHeader.style.color = "white";
        }

        // *** CAMBIO: Estructura interna con mini-dashboard de estados delante de las órdenes ***
        oTechHeader.innerHTML = `
            <div style="position: sticky; left: 20px; width: fit-content; display: flex; align-items: center; gap: 15px;">
                <span class="collapse-icon">${isCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight: bold; min-width: 200px;">👤 ${bIsUnassigned ? 'PENDIENTES: ' : 'Mecánico: '} ${techName}</span>
                
                <div style="display: flex; gap: 6px; align-items: center; margin-left: 10px;">
                    ${oT.u100 > 0 ? `<div class="legend-box status-u100" style="min-width:22px; height:22px; font-size:10px; margin:0;" title="Pendiente">${oT.u100}</div>` : ''}
                    ${oT.u200 > 0 ? `<div class="legend-box status-u200" style="min-width:22px; height:22px; font-size:10px; margin:0;" title="En Proceso">${oT.u200}</div>` : ''}
                    ${oT.u300 > 0 ? `<div class="legend-box status-u300" style="min-width:22px; height:22px; font-size:10px; margin:0;" title="Finalizada">${oT.u300}</div>` : ''}
                    ${oT.u400 > 0 ? `<div class="legend-box status-u400" style="min-width:22px; height:22px; font-size:10px; margin:0;" title="Pte. Firma">${oT.u400}</div>` : ''}
                    ${oT.abie > 0 ? `<div class="legend-box status-abie" style="min-width:22px; height:22px; font-size:10px; margin:0; color:#b9770e;" title="Abierta">${oT.abie}</div>` : ''}
                    <span style="font-size: 0.7rem; opacity: 0.8; margin-left: 5px;">(${aOrdersByTech.length})</span>
                </div>
            </div>
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
            
            const bIsLocked = oOrder.status.startsWith("status-u");
            oBar.className = `gantt-bar-custom ${oOrder.status} ${bIsLocked ? "order-locked" : ""} ${bHasPendingChanges ? "order-changed" : ""}`;
            
            oBar.draggable = !bIsLocked;
            
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
            const sCleanId = oOrder.id.replace(/^0+/, ""); // Quita ceros a la izquierda

            oBar.innerHTML = `
    <div class="bar-id" style="pointer-events:none; font-size: 0.7rem; font-weight: bold; opacity: 0.9;">
         ${sLockIcon}${sWarningIcon}Orden: ${sCleanId}
     </div>
    <div class="bar-equipment" style="pointer-events:none; font-size: 0.65rem;">EQ: ${(oOrder as any).equipment || "N/A"}</div>
    <div class="bar-customer" style="pointer-events:none; font-size: 0.65rem;">${(oOrder as any).customerName || "N/A"}</div>
`;

            oRow.appendChild(oBar);
            oContainer.appendChild(oRow);
        });
    });

    // Línea de "Hoy" y buscador
    const oNow = new Date();
    if (oNow.getMonth() === dStartProject.getMonth() && oNow.getFullYear() === dStartProject.getFullYear()) {
        const iTodayOffset = this._getDaysDiff(dStartProject, oNow);
        const iExactOffset = iTodayOffset + (oNow.getHours() / 24) + (oNow.getMinutes() / 1440);
        
        const oTodayLine = document.createElement("div");
        oTodayLine.className = "gantt-today-line";
        oTodayLine.style.left = `${iExactOffset * iDayWidth}px`;
        oTodayLine.innerHTML = `<span class="today-label">Hoy</span>`;
        oContainer.appendChild(oTodayLine);
        
        const oSearchField = this.byId("searchOrders") as any;
        if (oSearchField && oSearchField.getValue()) {
            this.onSearchGantt({ getParameter: () => oSearchField.getValue() });
        }

        // *** CAMBIO: Scroll automático a la fecha actual (Hoy) ***
        setTimeout(() => {
            const iScrollTarget = iTodayOffset * iDayWidth;
            const oDivScroll = document.getElementById("realGanttId")?.parentElement;
            if (oDivScroll) {
                oDivScroll.scrollTo({
                    left: iScrollTarget - (window.innerWidth / 3), 
                    behavior: 'smooth'
                });
            }
        }, 700);
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
    const aOrders = oModel.getProperty("/orders") || [];
    const oOrder = aOrders.find((o: any) => o.id === orderId);

    if (oOrder) {
        // --- 1. VALIDACIÓN DE BLOQUEO POR ESTATUS ---
        if (oOrder.status && oOrder.status.startsWith("status-u")) {
            MessageToast.show("No se puede mover: La orden ya tiene un estatus de gestión.");
            return;
        }

        // --- 2. DETECTAR SI CAMBIÓ EL MECÁNICO ---
        const sOriginalTechnician = oOrder.technician;
        const bIsNewTech = sOriginalTechnician !== newTechnician;

        const cursorOffsetX = parseInt(e.dataTransfer?.getData("cursorOffsetX") || "0");
        const oContainer = document.getElementById("realGanttId");
        if (!oContainer) return;

        const rect = oContainer.getBoundingClientRect();
        const iDayWidth = 120;
        
        // 3. CÁLCULOS DE POSICIÓN X RELATIVA
        const x = e.clientX - rect.left - cursorOffsetX;
        const newDayOffset = Math.floor((x + (iDayWidth / 2)) / iDayWidth);
        const dStartProject = oModel.getProperty("/startDateProject");
        
        // 4. CÁLCULO DE DURACIÓN ORIGINAL
        let durationDays = this._getDaysDiff(oOrder.start, oOrder.end);
        if (durationDays <= 0) durationDays = 1;

        // 5. ASIGNACIÓN DE NUEVAS FECHAS (Ajuste Anti-Desfase)
        const newStart = new Date(dStartProject.getTime());
        newStart.setDate(dStartProject.getDate() + newDayOffset);
        
        /** * FIX CRÍTICO: Seteamos a las 12:00 PM para evitar desfases de zona horaria al enviar a SAP */
        newStart.setHours(12, 0, 0, 0);
        
        const newEnd = new Date(newStart.getTime());
        newEnd.setDate(newStart.getDate() + durationDays);
        newEnd.setHours(12, 0, 0, 0);

        // 6. ACTUALIZACIÓN DEL MODELO LOCAL
        oOrder.start = newStart;
        oOrder.end = newEnd;
        oOrder.technician = newTechnician;
        oModel.setProperty("/orders", aOrders);

        // --- 7. REGISTRO DE CAMBIOS PARA SAP ---
        const oChange = {
            Orderid: oOrder.id.padStart(12, '0'),
            StartDate: newStart, 
            FinishDate: newEnd,
            IdMecanico: oOrder.technician,
            hasTechChange: bIsNewTech // Esta bandera se usará en onSaveSAP
        };

        if (!this._aPendingChanges) { this._aPendingChanges = []; }
        this._aPendingChanges = this._aPendingChanges.filter(c => c.Orderid !== oChange.Orderid);
        this._aPendingChanges.push(oChange);

        // Actualización visual de botones
        const oBtnSave = this.byId("btnSave") as Button;
        const oBtnReset = this.byId("btnReset") as Button;
        if (oBtnSave) {
            oBtnSave.setEnabled(true);
            oBtnSave.setText(`Guardar Cambios (${this._aPendingChanges.length})`);
        }
        if (oBtnReset) {
            oBtnReset.setEnabled(true);
        }

        // 8. REFRESCAR GANTT
        this._renderCustomGantt();
        
        // *** CAMBIO: Actualización de contadores tras mover la orden ***
        this._updateOrderSummary();
        
        MessageToast.show(`Orden ${oOrder.id} movida correctamente`);
        console.log("Cambio registrado:", oChange);
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
        "WorkOrderHeader": { "Supervisor": "info@tellus-technologies.com" },
        "WorkOrderItemsSet": this._aPendingChanges.map(change => {
            let sMecId = "";
            
            // Solo procesamos el ID del mecánico si hubo un cambio de carril (técnico)
            if (change.hasTechChange) {
                const sOriginalMec = change.IdMecanico || "";
                if (sOriginalMec !== "" && sOriginalMec !== "Sin Asignar") {
                    const oMatch = sOriginalMec.match(/\(([^)]+)\)/);
                    sMecId = oMatch ? oMatch[1] : sOriginalMec;
                }
            }
            // Si hasTechChange es falso, sMecId permanece como ""

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

// *** CAMBIO: Nueva función para exportar a Excel con 3 pestañas ***
    // *** CAMBIO: Función de exportación actualizada (Sin cronograma y con descripciones de estado) ***
// *** CAMBIO: Función de exportación con ordenamiento cronológico y descripciones ***
// *** CAMBIO: Función de exportación con limpieza de ceros y título de meses dinámico ***
public async onExportExcel(): Promise<void> {
    const oView = this.getView();
    oView!.setBusy(true);
    try {
        if (!(window as any).XLSX) {
            await this._loadLibrary("https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js");
        }
        const XLSX = (window as any).XLSX;
        const oModel = oView!.getModel("plan") as JSONModel;
        const aOrders = oModel.getProperty("/orders") || [];
        const oSummary = oModel.getProperty("/summary") || {};
        
        // Obtener rango de fechas para el nombre del archivo
        const oRange = this.byId("rangeSelection") as any;
        const dStartReq = oRange.getDateValue();
        const dEndReq = oRange.getSecondDateValue();

        // Lógica para el nombre del mes
        const fnGetMonthName = (d: Date) => d.toLocaleDateString('es-ES', { month: 'long' }).toUpperCase();
        let sPeriodo = fnGetMonthName(dStartReq);
        if (dStartReq.getMonth() !== dEndReq.getMonth()) {
            sPeriodo += `-${fnGetMonthName(dEndReq)}`;
        }

        // --- MAPEO DE DESCRIPCIONES DE ESTADO ---
        const fnGetStatusDesc = (sStatus: string) => {
            switch (sStatus) {
                case "status-u100": return "Orden Pendiente";
                case "status-u200": return "Orden En proceso";
                case "status-u300": return "Orden Finalizada";
                case "status-u400": return "Orden Pendiente de firma";
                case "status-abie": return "Orden Planificada SAP";
                default: return "Orden Liberada SAP Y BTP";
            }
        };

        // Ordenar por fecha inicio y limpiar ceros del ID
        const aSortedOrders = [...aOrders].sort((a: any, b: any) => a.start.getTime() - b.start.getTime());

        // 1. Pestaña Maestro
        const aMaestro = aSortedOrders.map((o: any) => ({
            "Orden": o.id.replace(/^0+/, ""), // *** CAMBIO: Quita ceros a la izquierda ***
            "Descripción": o.desc, 
            "Mecánico": o.technician,
            "Equipo": o.equipment, 
            "Cliente": o.customerName,
            "Fecha Inicio": o.start.toLocaleDateString('es-ES'), 
            "Fecha Fin": o.end.toLocaleDateString('es-ES'),
            "Estado": fnGetStatusDesc(o.status)
        }));
        
        const wsMaestro = XLSX.utils.json_to_sheet(aMaestro);

        // 2. Pestaña Resumen
        const aDashboard = [
            { "Indicador": "Pendientes", "Total": oSummary.u100 },
            { "Indicador": "En Proceso", "Total": oSummary.u200 },
            { "Indicador": "Finalizadas", "Total": oSummary.u300 },
            { "Indicador": "Pendiente Firma", "Total": oSummary.u400 },
            { "Indicador": "Abiertas", "Total": oSummary.abie },
            { "Indicador": "Cambios sin Guardar", "Total": oSummary.changed }
        ];
        const wsDashboard = XLSX.utils.json_to_sheet(aDashboard);

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, wsMaestro, "Reporte");
        XLSX.utils.book_append_sheet(wb, wsDashboard, "Resumen");

        // *** CAMBIO: Nombre de archivo dinámico con el mes solicitado ***
        XLSX.writeFile(wb, `Reporte_Planificacion_${sPeriodo}.xlsx`);
        
        MessageToast.show("Excel generado correctamente.");
    } catch (e) { 
        MessageBox.error("Error al exportar."); 
    }
    finally { 
        oView!.setBusy(false); 
    }
}

// *** CAMBIO: La función _loadLibrary se mantiene igual para cargar el script ***
private _loadLibrary(sSrc: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = sSrc;
        script.onload = () => resolve();
        script.onerror = () => reject();
        document.head.appendChild(script);
    });
}
// *** CAMBIO: Lógica para Expandir Todo ***
// *** CAMBIO: Lógica para Expandir Todo el Gantt ***
public onExpandAll(): void {
    // Reiniciamos el mapa de colapsos para que todo sea visible
    this._mCollapsedGroups = {}; 
    this._renderCustomGantt();
}

// *** CAMBIO: Lógica para Colapsar Todo el Gantt ***
public onCollapseAll(): void {
    const oModel = this.getView()!.getModel("plan") as JSONModel;
    const aOrders = oModel.getProperty("/orders") || [];
    
    // Recorremos las órdenes para identificar a todos los mecánicos y marcarlos como colapsados
    aOrders.forEach((oOrder: MaintenanceOrder) => {
        const tech = oOrder.technician || "Sin Asignar";
        this._mCollapsedGroups[tech] = true;
    });

    this._renderCustomGantt();
}

}