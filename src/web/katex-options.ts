import 'katex/contrib/mhchem';

export const KATEX_OPTIONS = {
  strict: 'ignore' as const,
  macros: {
    '\\argmin': '\\operatorname*{arg\\,min}',
    '\\argmax': '\\operatorname*{arg\\,max}',
    '\\bm': '\\boldsymbol{#1}',
    '\\abs': '\\left|#1\\right|',
    '\\norm': '\\left\\lVert#1\\right\\rVert',
    '\\ket': '\\left|#1\\right\\rangle',
    '\\bra': '\\left\\langle#1\\right|',
    '\\braket': '\\left\\langle#1\\middle|#2\\right\\rangle',
    '\\dv': '\\frac{d#1}{d#2}',
    '\\pdv': '\\frac{\\partial#1}{\\partial#2}',
    '\\E': '\\mathbb{E}',
    '\\Var': '\\operatorname{Var}',
    '\\R': '\\mathbb{R}',
    '\\N': '\\mathbb{N}',
    '\\Z': '\\mathbb{Z}',
  },
};
