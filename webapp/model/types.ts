
export interface MaintenanceOrder {
    id: string;
    desc: string;
    start: Date;
    end: Date;
    status: string
    technician: string;
}

export interface SAPOrder {
    OrderID: string;
    Description: string;
    StartDate: Date;
    FinishDate: Date;
    Status: string;
    TechnicianName?: string;
    equipment?: string;
    NombreCliente?:string;
}