import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap/dist/js/bootstrap.bundle.min.js';
import 'bootstrap-icons/font/bootstrap-icons.css';
import Chart from 'chart.js/auto';
import marked from 'marked';
import { initI18n, setLocale, locales } from './locales/index.js';

// 初始化多语言
await initI18n();