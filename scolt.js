/**
 * SCOLT - Convert nested JSON structures into a compact columnar table structure
 *
 * @example
 * const scolt = new SCOLT();
 * const result = scolt.parse(jsonData, {
 *   defaultValues: { status: 'active' },
 *   tableStructure: { users: 'userList' }
 * });
 */
export class SCOLT {
  constructor() {
    this.initialize();
  }

  initialize() {
    this.tableRegistry = new Map();
    this.arrayReferenceCache = new Map();
    this.tableIndexCounters = new Map();
    this.rootLevelKeys = new Set();
    this.objectToIndexMap = new Map();
  }

  /**
   * @param {Object|Array|string} data - The JSON data to parse
   * @param {Object} [config={}] - Parser configuration
   * @param {Object} [config.defaultValues={}] - Default values for missing fields
   * @param {Object} [config.tableStructure={}] - Custom table name mappings
   * @returns {string} The tabular SCOLT format
   */
  parse(data, config = {}) {
    this.initialize();
    this.defaultValues = config.defaultValues || {};
    this.tableStructure = config.tableStructure || {};

    if (typeof data === "string") {
      data = JSON.parse(data);
    }

    if (data && typeof data === "object" && !Array.isArray(data)) {
      Object.keys(data).forEach((key) => this.rootLevelKeys.add(key));
    }

    this.processValue(data, "root");
    this.compactArrayReferences();
    this.optimizeTableReferences();

    return this.buildTabularOutput(data);
  }

  applyDefaultsToRow(sourceObject, columnNames) {
    const normalizedRow = {};

    for (const columnName of columnNames) {
      if (columnName in sourceObject) {
        normalizedRow[columnName] =
          sourceObject[columnName] ?? this.defaultValues[columnName] ?? null;
      } else {
        normalizedRow[columnName] = this.defaultValues[columnName] ?? null;
      }
    }

    return normalizedRow;
  }

  generateCanonicalKey(sourceObject, columnNames) {
    const canonicalRepresentation = {};

    for (const columnName of columnNames) {
      const value =
        sourceObject[columnName] ?? this.defaultValues[columnName] ?? null;

      if (value && typeof value === "object") {
        canonicalRepresentation[columnName] = JSON.stringify(value);
      } else {
        canonicalRepresentation[columnName] = value;
      }
    }

    return JSON.stringify(canonicalRepresentation);
  }

  processValue(value, context) {
    if (!value || typeof value !== "object") return;

    const cacheKey = JSON.stringify(value);
    if (this.arrayReferenceCache.has(cacheKey)) return;

    if (Array.isArray(value)) {
      this.processArrayValue(value, context, cacheKey);
    } else {
      this.processObjectValue(value, context);
    }
  }

  processArrayValue(array, context, cacheKey) {
    if (!array.length) {
      this.arrayReferenceCache.set(cacheKey, "[]");
      return;
    }

    const firstElement = array[0];

    // Check if this is an array of primitives or arrays (not objects with properties)
    if (
      typeof firstElement !== "object" ||
      firstElement === null ||
      Array.isArray(firstElement)
    ) {
      // Serialize as a nested array structure
      const serializedArray = array
        .map((item) => {
          if (Array.isArray(item)) {
            // Recursively handle nested arrays
            return `[${item.map((v) => this.serializePrimitive(v)).join(",")}]`;
          }
          return this.serializePrimitive(item);
        })
        .join(",");
      this.arrayReferenceCache.set(cacheKey, `[${serializedArray}]`);
      return;
    }

    // Original logic for arrays of objects
    const tableName = this.resolveTableName(context);
    const extractedColumns = this.extractColumnNames(array);

    // If no columns were extracted, treat as primitive array
    if (extractedColumns.length === 0) {
      const primitiveArray = array
        .map((value) => this.serializePrimitive(value))
        .join(",");
      this.arrayReferenceCache.set(cacheKey, `[${primitiveArray}]`);
      return;
    }

    if (!this.tableRegistry.has(tableName)) {
      this.createNewTable(tableName, extractedColumns);
    } else {
      this.mergeTableColumns(tableName, extractedColumns);
    }

    const table = this.tableRegistry.get(tableName);
    const columns = table.columns;
    const canonicalKeyMap = this.objectToIndexMap.get(tableName);
    const rowIndices = [];

    array.forEach((item) => {
      columns.forEach((columnName) => {
        const nestedValue = item[columnName];
        if (nestedValue && typeof nestedValue === "object") {
          this.processValue(nestedValue, columnName);
        }
      });

      const normalizedRow = this.applyDefaultsToRow(item, columns);
      const canonicalKey = this.generateCanonicalKey(normalizedRow, columns);

      if (canonicalKeyMap.has(canonicalKey)) {
        rowIndices.push(canonicalKeyMap.get(canonicalKey));
      } else {
        const rowIndex = this.addRowToTable(
          tableName,
          item,
          normalizedRow,
          columns,
          canonicalKey
        );
        rowIndices.push(rowIndex);
      }
    });

    this.arrayReferenceCache.set(
      cacheKey,
      `${tableName}[${rowIndices.join(",")}]`
    );
  }

  processObjectValue(object, context) {
    const tableName = this.resolveTableName(context);
    const extractedColumns = this.sortColumnNames(Object.keys(object));

    if (!this.tableRegistry.has(tableName)) {
      this.createNewTable(tableName, extractedColumns);
    } else {
      this.mergeTableColumns(tableName, extractedColumns);
    }

    const table = this.tableRegistry.get(tableName);
    const columns = table.columns;
    const canonicalKeyMap = this.objectToIndexMap.get(tableName);

    columns.forEach((columnName) => {
      const nestedValue = object[columnName];
      if (nestedValue && typeof nestedValue === "object") {
        this.processValue(nestedValue, columnName);
      }
    });

    const normalizedRow = this.applyDefaultsToRow(object, columns);
    const canonicalKey = this.generateCanonicalKey(normalizedRow, columns);

    if (!canonicalKeyMap.has(canonicalKey)) {
      this.addRowToTable(
        tableName,
        object,
        normalizedRow,
        columns,
        canonicalKey
      );
    }
  }

  createNewTable(tableName, columns) {
    this.tableRegistry.set(tableName, {
      columns: columns,
      rows: [],
      originalData: [],
    });
    this.tableIndexCounters.set(tableName, 0);
    this.objectToIndexMap.set(tableName, new Map());
  }

  mergeTableColumns(tableName, newColumns) {
    const table = this.tableRegistry.get(tableName);
    const existingColumns = new Set(table.columns);
    const mergedColumns = [...table.columns];

    for (const column of newColumns) {
      if (!existingColumns.has(column)) {
        mergedColumns.push(column);
      }
    }

    const sortedColumns = this.sortColumnNames(mergedColumns);

    if (this.hasColumnsChanged(table.columns, sortedColumns)) {
      this.rebuildTableWithNewColumns(tableName, sortedColumns);
    }
  }

  rebuildTableWithNewColumns(tableName, newColumns) {
    const table = this.tableRegistry.get(tableName);
    table.columns = newColumns;

    const newCanonicalKeyMap = new Map();

    table.rows = table.originalData.map((item, index) => {
      const normalizedRow = this.applyDefaultsToRow(item, newColumns);
      const canonicalKey = this.generateCanonicalKey(normalizedRow, newColumns);
      newCanonicalKeyMap.set(canonicalKey, index);

      return newColumns.map((columnName) => {
        const value = normalizedRow[columnName];
        return typeof value === "object"
          ? this.resolveReference(value, columnName)
          : this.serializePrimitive(value);
      });
    });

    this.objectToIndexMap.set(tableName, newCanonicalKeyMap);
  }

  addRowToTable(tableName, originalItem, normalizedRow, columns, canonicalKey) {
    const table = this.tableRegistry.get(tableName);
    const canonicalKeyMap = this.objectToIndexMap.get(tableName);

    const row = columns.map((columnName) => {
      const value = normalizedRow[columnName];
      return typeof value === "object"
        ? this.resolveReference(value, columnName)
        : this.serializePrimitive(value);
    });

    const rowIndex = table.rows.length;
    table.rows.push(row);
    table.originalData.push(originalItem);
    canonicalKeyMap.set(canonicalKey, rowIndex);
    this.tableIndexCounters.set(tableName, rowIndex + 1);

    return rowIndex;
  }

  resolveReference(value, context) {
    if (!value || typeof value !== "object") {
      return this.serializePrimitive(value);
    }

    const cacheKey = JSON.stringify(value);
    if (this.arrayReferenceCache.has(cacheKey)) {
      return this.arrayReferenceCache.get(cacheKey);
    }

    const tableName = this.resolveTableName(context);
    const table = this.tableRegistry.get(tableName);

    if (!table) return "null";

    if (!Array.isArray(value)) {
      const columns = table.columns;
      const normalizedRow = this.applyDefaultsToRow(value, columns);
      const canonicalKey = this.generateCanonicalKey(normalizedRow, columns);
      const canonicalKeyMap = this.objectToIndexMap.get(tableName);

      if (canonicalKeyMap && canonicalKeyMap.has(canonicalKey)) {
        return `${tableName}[${canonicalKeyMap.get(canonicalKey)}]`;
      }
    }

    return `${tableName}[${table.rows.length - 1}]`;
  }

  resolveTableName(context) {
    const customMapping = this.tableStructure[context];
    return customMapping ? `@${customMapping}` : `@${context}`;
  }

  extractColumnNames(array) {
    const columnSet = new Set();
    array.forEach((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        Object.keys(item).forEach((key) => columnSet.add(key));
      }
    });
    return this.sortColumnNames(Array.from(columnSet));
  }

  sortColumnNames(columns) {
    const priorityColumns = ["id", "name", "type", "key"];
    return columns.sort((a, b) => {
      const indexA = priorityColumns.indexOf(a);
      const indexB = priorityColumns.indexOf(b);
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return a.localeCompare(b);
    });
  }

  hasColumnsChanged(oldColumns, newColumns) {
    return (
      oldColumns.length !== newColumns.length ||
      !newColumns.every((column, index) => column === oldColumns[index])
    );
  }

  serializePrimitive(value) {
    if (value === null || value === undefined) return "null";
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    if (typeof value === "string") {
      if (value.trim() === "") return '""';
      return /[,\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
    }
    return String(value);
  }

  compactArrayReferences() {
    for (const [cacheKey, reference] of this.arrayReferenceCache) {
      const match = reference.match(/^(@\w+)\[([\d,]+)\]$/);
      if (!match) continue;

      const tableName = match[1];
      const indices = match[2]
        .split(",")
        .map(Number)
        .sort((a, b) => a - b);
      const table = this.tableRegistry.get(tableName);
      if (!table) continue;

      if (this.isSequentialFullTableReference(indices, table.rows.length)) {
        this.arrayReferenceCache.set(cacheKey, tableName);
      }
    }
  }

  optimizeTableReferences() {
    for (const [, table] of this.tableRegistry) {
      table.rows = table.rows.map((row) =>
        row.map((cell) => {
          if (typeof cell !== "string" || !cell.startsWith("@")) return cell;
          const match = cell.match(/^(@\w+)\[([\d,]+)\]$/);
          if (!match) return cell;
          const tableName = match[1];
          const indices = match[2]
            .split(",")
            .map(Number)
            .sort((a, b) => a - b);
          const referencedTable = this.tableRegistry.get(tableName);
          if (!referencedTable) return cell;
          if (
            this.isSequentialFullTableReference(
              indices,
              referencedTable.rows.length
            )
          ) {
            return tableName;
          }
          return cell;
        })
      );
    }
  }

  isSequentialFullTableReference(indices, totalRows) {
    return (
      indices.length === totalRows &&
      indices.every((value, index) => value === index)
    );
  }

  buildTabularOutput(rootData) {
    const tableLines = [];
    const dependencyOrder = this.computeTopologicalOrder();

    for (const tableName of dependencyOrder) {
      if (tableName === "@root") continue;
      const keyName = tableName.slice(1);
      if (this.rootLevelKeys.has(keyName)) continue;
      const table = this.tableRegistry.get(tableName);
      if (!table || !table.rows.length) continue;
      tableLines.push(this.formatTableOutput(tableName, table));
    }

    const rootLines = this.buildRootOutput(rootData);
    const tablesSection = tableLines.join("\n\n");
    const rootSection = rootLines.join("\n");
    return tablesSection
      ? rootSection
        ? `${tablesSection}\n\n${rootSection}`
        : tablesSection
      : rootSection;
  }

  formatTableOutput(tableName, table) {
    const header = `${tableName}{${table.columns.join(",")}}:`;
    if (table.rows.length === 1) {
      return `${header} ${table.rows[0].join(",")}`;
    }
    const formattedRows = table.rows
      .map((row) => `  ${row.join(",")}`)
      .join("\n");
    return `${header}\n${formattedRows}`;
  }

  buildRootOutput(rootData) {
    const rootLines = [];
    if (Array.isArray(rootData)) {
      rootLines.push(this.resolveReference(rootData, "root"));
    } else if (rootData && typeof rootData === "object") {
      for (const [key, value] of Object.entries(rootData)) {
        const reference = this.resolveReference(value, key);
        const match = reference.match(/^(@\w+)(\[.*)?$/);
        if (match) {
          const tableName = match[1];
          const expectedTableName = this.resolveTableName(key);
          if (tableName === expectedTableName) {
            const table = this.tableRegistry.get(tableName);
            if (table) {
              rootLines.push(this.formatRootTable(key, table));
              continue;
            }
          }
        }
        rootLines.push(`#${key}: ${reference}`);
      }
    } else {
      rootLines.push(String(rootData));
    }
    return rootLines;
  }

  formatRootTable(key, table) {
    const header = `#${key}{${table.columns.join(",")}}:`;
    if (table.rows.length === 1) {
      return `${header} ${table.rows[0].join(",")}`;
    }
    const formattedRows = table.rows
      .map((row) => `  ${row.join(",")}`)
      .join("\n");
    return `${header}\n${formattedRows}`;
  }

  computeTopologicalOrder() {
    const dependencyGraph = this.buildDependencyGraph();
    const sortedOrder = [];
    const visitedNodes = new Set();
    const visitingNodes = new Set();

    const visitNode = (node) => {
      if (visitedNodes.has(node)) return;
      if (visitingNodes.has(node)) return;
      visitingNodes.add(node);
      const dependencies = dependencyGraph.get(node) || [];
      dependencies.forEach((dependency) => {
        if (dependencyGraph.has(dependency)) {
          visitNode(dependency);
        }
      });
      visitingNodes.delete(node);
      visitedNodes.add(node);
      sortedOrder.push(node);
    };

    for (const tableName of dependencyGraph.keys()) {
      visitNode(tableName);
    }

    return sortedOrder;
  }

  buildDependencyGraph() {
    const dependencyGraph = new Map();
    for (const [tableName, table] of this.tableRegistry) {
      const dependencies = new Set();
      table.rows.forEach((row) =>
        row.forEach((cell) => {
          if (typeof cell === "string" && cell.startsWith("@")) {
            const referencedTable = cell.split(/[\[{]/)[0];
            if (referencedTable !== tableName) {
              dependencies.add(referencedTable);
            }
          }
        })
      );
      dependencyGraph.set(tableName, Array.from(dependencies));
    }
    return dependencyGraph;
  }
}
