import { useEffect, useRef } from 'react';

type Point = { observed_at: number; base_cents: number | null; link_id: number };
type Sample = Point & { base_cents: number };
const colors = ['#41e1d1', '#ffae6b', '#b0a1ff', '#ff9cc1', '#e6df87'];

export default function PriceHistoryPlot({ history }: { history: Point[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const points = history.filter((row): row is Sample => row.base_cents !== null);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !points.length) return;
    const plot = element.getContext('2d');
    if (!plot) return;
    function draw() {
      if (!element || !plot) return;
      const width = element.clientWidth;
      const height = element.clientHeight;
      const scale = window.devicePixelRatio || 1;
      element.width = Math.round(width * scale);
      element.height = Math.round(height * scale);
      plot.scale(scale, scale);
      plot.font = '11px system-ui';
      const left = 49, right = width - 16, top = 17, bottom = height - 26;
      const prices = points.map(row => row.base_cents);
      const min = Math.min(...prices), max = Math.max(...prices);
      const step = Math.max(100, Math.ceil((max - min) / 400) * 100);
      const low = Math.max(0, Math.floor((min - step / 2) / step) * step);
      const high = Math.ceil((max + step / 2) / step) * step;
      const timestamps = history.map(row => row.observed_at);
      const start = Math.min(...timestamps), end = Math.max(...timestamps);
      const links = [...new Set(points.map(point => point.link_id))];
      plot.fillStyle = '#b2b9c7';
      plot.strokeStyle = '#3b4957';
      plot.textAlign = 'right';
      plot.textBaseline = 'middle';
      for (let price = low; price <= high; price += step) {
        const y = bottom - (price - low) / (high - low) * (bottom - top);
        plot.beginPath(); plot.moveTo(left, y); plot.lineTo(right, y); plot.stroke();
        plot.fillText(`${price / 100} €`, left - 7, y);
      }
      for (const point of points) {
        const x = start === end ? (left + right) / 2 : left + (point.observed_at - start) / (end - start) * (right - left);
        const y = bottom - (point.base_cents - low) / (high - low) * (bottom - top);
        plot.fillStyle = colors[links.indexOf(point.link_id) % colors.length];
        plot.beginPath(); plot.arc(x, y, 4, 0, 2 * Math.PI); plot.fill();
      }
      const date = (value: number) => new Date(value * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
      plot.fillStyle = '#b2b9c7';
      plot.textAlign = start === end ? 'center' : 'left';
      plot.fillText(date(start), start === end ? (left + right) / 2 : left, height - 10);
      if (start !== end) { plot.textAlign = 'right'; plot.fillText(date(end), right, height - 10); }
    }
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    draw();
    return () => observer.disconnect();
  }, [history, points]);
  return points.length > 0 && <canvas className="history-plot" ref={canvas} aria-hidden="true" />;
}
