import { createContext } from 'react';
import type { TableAdaptController } from '../lib/tableAdapter';

/** Lets each mounted chapter register itself for table adaptation; null (the default) means "don't". */
export const TableAdaptContext = createContext<TableAdaptController | null>(null);
