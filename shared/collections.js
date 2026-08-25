// Firestore collection names, matching the "Database Table" column of the
// Full Asset Register Dictionary, prefixed with "AT_" so every collection
// this app owns is grouped together and easy to pick out from anything
// else sharing the same Firebase project.
//
// Every read/write in the app goes through these COLLECTIONS.* keys —
// nothing hardcodes a raw collection name — so this file is the only
// place a rename like this needs to happen.

export const COLLECTIONS = {
  ASSET_REGISTER: "AT_AssetRegister",
  ASSET_TYPES: "AT_AssetTypes",
  ASSET_CATEGORIES: "AT_AssetCategories",
  EMPLOYEE_REGISTER: "AT_EmployeeRegister",
  SUPPLIER_REGISTER: "AT_SupplierRegister",
  LOCATION_REGISTER: "AT_LocationRegister",
  LOCATION_TYPES: "AT_LocationTypes",
  CALIBRATION_REGISTER: "AT_CalibrationRegister",
  REPAIR_REGISTER: "AT_RepairRegister",
  RECHARGE_REGISTER: "AT_RechargeRegister",
  RETIREMENT_REGISTER: "AT_RetirementRegister",
  MOVEMENT_REGISTER: "AT_MovementRegister",
  ASSIGNMENT_HISTORY: "AT_AssignmentHistory",
  ASSET_INSPECTION: "AT_AssetInspection",
  ASSET_INCIDENT: "AT_AssetIncident",
  ASSET_RECOVERY: "AT_AssetRecovery",
  COUNTERS: "AT_Counters",
  AUDIT_LOG: "AT_AuditLog",
  USERS: "AT_Users",
};
