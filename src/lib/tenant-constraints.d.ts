export type CompositeTenantForeignKey = {
  readonly childTable: string;
  readonly childColumn: string;
  readonly parentTable: string;
  readonly constraintName: string;
  readonly deleteAction: string;
  readonly deleteColumns: string;
  readonly deleteCode: string;
};

export type ConstraintInventoryRow = {
  child_table: string;
  child_column: string;
  parent_table: string;
  constraint_name: string;
  present: boolean;
  validated: boolean;
  definition: string | null;
  problem: string | null;
};

export type ConstraintInventory = {
  /** How many constraints migration 0018 installs. */
  expected: number;
  /** How many were found in the catalog. */
  present: number;
  /** How many were found AND correct. */
  valid: number;
  /** True when every expected constraint is present and correct. */
  complete: boolean;
  /** Human-readable description of every problem found. */
  problems: string[];
};

export declare const COMPOSITE_TENANT_FOREIGN_KEYS: readonly CompositeTenantForeignKey[];
export declare const COMPOSITE_TENANT_FOREIGN_KEY_COUNT: number;
export declare const COMPOSITE_TENANT_MIGRATION: string;
export declare const CONSTRAINT_INVENTORY_SQL: string;
export declare const UNIQUE_SCHOOL_ID_TARGET_TABLES: readonly string[];
export declare const UNIQUE_TARGET_INVENTORY_SQL: string;

export declare function compositeConstraintNames(): string[];

export declare function summarizeConstraintInventory(
  rows: ConstraintInventoryRow[] | null | undefined
): ConstraintInventory;

export declare function describeConstraintProblems(
  inventory: ConstraintInventory,
  maxProblems?: number
): string;

export declare function uniqueTargetIndexName(table: string): string;

export declare function uniqueTargetIndexSql(table: string): string;
