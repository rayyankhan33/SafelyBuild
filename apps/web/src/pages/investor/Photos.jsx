// Investor photos page: the latest site camera pictures.
import { PhotoGrid } from '../../components.jsx';
import { Footnote } from './Shared.jsx';

export default function Photos({ data }) {
  return (
    <>
      <div className="card"><h2>Recent site photos</h2><PhotoGrid media={data.recent_media} /></div>
      <p className="tiny">Pictures come straight from the fixed site cameras; nobody on site can upload or remove them.</p>
      <Footnote data={data} />
    </>
  );
}
