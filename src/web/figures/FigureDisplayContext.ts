import { createContext, useContext } from 'react';

export const FigureDisplayContext = createContext(false);
export const useFigureExpanded = () => useContext(FigureDisplayContext);

export const FigureCloseContext = createContext<() => void>(() => {});
export const useCloseFigure = () => useContext(FigureCloseContext);
