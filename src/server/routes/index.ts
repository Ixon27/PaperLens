import { Hono } from 'hono';
import { analysis } from './analysis';
import { citations } from './citations';
import { exportRoutes } from './export';
import { highlights } from './highlights';
import { jobs } from './jobs';
import { mindmap } from './mindmap';
import { openalexRoutes } from './openalex';
import { papers } from './papers';
import { settings } from './settings';
import { threads } from './threads';
import { translation } from './translation';

export const api = new Hono();

api.route('/', settings);
api.route('/', jobs);
api.route('/', papers);
api.route('/', highlights);
api.route('/', threads);
api.route('/', translation);
api.route('/', analysis);
api.route('/', mindmap);
api.route('/', citations);
api.route('/', openalexRoutes);
api.route('/', exportRoutes);
