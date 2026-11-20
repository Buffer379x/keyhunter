import { CountryFlag } from './Country';
/** Flag next to a visible country name: decorative, so screen readers read the name once. */
export default function Flag({ region }: { region: string | null | undefined }) {
  return <span className="flag-wrap" aria-hidden="true"><CountryFlag region={region} /></span>;
}
