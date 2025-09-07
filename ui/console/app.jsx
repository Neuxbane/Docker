const { useState, useEffect } = React;

function isIpv4(s) {
  if (!s) return false;
  const parts = s.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => { const n = Number(p); return Number.isInteger(n) && n >= 0 && n <= 255; });
}

function isPortMapping(v) {
  // allow forms: "container", "host:container", or "ip:host:container"
  if (!v || typeof v !== 'string') return false;
  if (/^\d+$/.test(v)) return Number(v) > 0 && Number(v) <= 65535;
  const parts = v.split(':');
  if (parts.length === 2) return /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]);
  if (parts.length === 3) {
    // first part should be ipv4 (bind), second and third are numeric ports
    return isIpv4(parts[0]) && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]);
  }
  return false;
}

function normalizeNetworks(n){
  if (!n) return {};
  const out = {};
  for (const [k,v] of Object.entries(n)){
    if (v === null || v === undefined) out[k] = '';
    else if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'object') out[k] = v.ipv4_address || v.ipv4Address || '';
    else out[k] = String(v);
  }
  return out;
}

function ProjectList({mapper, onEdit, onAdd, onRename, onDelete, onAttach}){
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Projects</h2>
        <button className="bg-green-600 text-white px-3 py-1 rounded" onClick={onAdd}>Add Project</button>
      </div>
      {Object.keys(mapper).length===0 && <div className="text-gray-500">No projects found</div>}
      {Object.entries(mapper).map(([path,item])=> {
        const folderName = path.split('/').pop();
        // Check if all services are strictly 'stopped'
        // treat any other transient state (stopping, restarting, running, unknown) as not-stopped
        const allServicesStopped = Object.values(item.services || {}).every(svc => 
          svc && svc.status === 'stopped'
        );
        // Check if at least one service is running (for Attach availability)
        const hasRunningService = Object.values(item.services || {}).some(svc => svc && svc.status === 'running');
        // Check if this is the template project
        const isTemplate = folderName === 'template';
        return (
          <div key={path} className="bg-white shadow rounded p-4 flex justify-between items-center">
            <div>
              <div className="font-medium">{folderName} {isTemplate && <span className="text-xs text-blue-600">(Template)</span>}</div>
              <div className="text-xs text-gray-500">services: {Object.keys(item.services||{}).join(', ')}</div>
              <div className="mt-2 flex gap-2">
                {Object.entries(item.services||{}).map(([svc, sdata])=> (
                  <div key={svc} className="text-xs px-2 py-1 rounded" style={{background: (sdata && sdata.status==='running')? '#dcfce7' : (sdata && (sdata.status==='stopping' || sdata.status==='restarting')? '#fff7ed' : '#fee2e2') }}>
                    <strong>{svc}</strong>: {(sdata && sdata.status) || 'unknown'}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button className="bg-blue-600 text-white px-3 py-1 rounded" onClick={()=>onEdit(path)}>Edit</button>
              {/* project-level Attach removed: attach is available per-service in the editor */}
              <button 
                className={`px-3 py-1 rounded ${allServicesStopped && !isTemplate ? 'bg-yellow-600 text-white' : 'bg-gray-400 text-white cursor-not-allowed'}`} 
                onClick={()=> allServicesStopped && !isTemplate && onRename && onRename(path)}
                disabled={!allServicesStopped || isTemplate}
                title={isTemplate ? 'Cannot rename template project' : (!allServicesStopped ? 'All services must be stopped to rename' : '')}
              >
                Rename
              </button>
              <button 
                className={`px-3 py-1 rounded ${allServicesStopped && !isTemplate ? 'bg-red-600 text-white' : 'bg-gray-400 text-white cursor-not-allowed'}`} 
                onClick={()=> allServicesStopped && !isTemplate && onDelete && onDelete(path)}
                disabled={!allServicesStopped || isTemplate}
                title={isTemplate ? 'Cannot delete template project' : (!allServicesStopped ? 'All services must be stopped to delete' : '')}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RenameProjectModal({path, onClose, onRename, mapper}){
  const [name, setName] = useState(path.split('/').pop());
  const [error, setError] = useState('');

  function checkAvailability(n) {
    if (!n.trim()) {
      setError('');
      return;
    }
    const folderName = n.trim();
    const exists = Object.keys(mapper).some(p => p.split('/').pop() === folderName && p !== path);
    if (exists) {
      setError('Name is not available');
    } else {
      setError('');
    }
  }

  useEffect(() => {
    checkAvailability(name);
  }, [name, mapper]);

  function handleRename() {
    if (!name.trim() || error) return;
    
    // Prevent renaming template project
    const currentName = path.split('/').pop();
    if (currentName === 'template') {
      setError('Cannot rename the template project');
      return;
    }
    
    onRename(path, name.trim());
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold">Rename Project</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">New Project Name</label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Enter new project name"
          />
          {error && <div className="text-sm text-red-600 mt-1">{error}</div>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
          <button
            className={`px-3 py-1 rounded ${error || !name.trim() ? 'bg-gray-400 cursor-not-allowed' : 'bg-yellow-600 text-white'}`}
            onClick={handleRename}
            disabled={error || !name.trim()}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteProjectModal({path, onClose, onDelete}){
  const [confirmName, setConfirmName] = useState('');
  const projectName = path.split('/').pop();
  const error = confirmName !== projectName ? 'Name does not match' : '';

  function handleDelete() {
    if (error) return;
    
    // Prevent deleting template project
    if (projectName === 'template') {
      return; // This shouldn't happen since the button should be disabled, but just in case
    }
    
    onDelete(path, confirmName);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold text-red-600">Delete Project</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="mb-4">
          <div className="text-sm text-gray-700 mb-2">
            Are you sure you want to delete the project <strong>{projectName}</strong>?
            {projectName === 'template' && <span className="text-red-600 block">Note: The template project cannot be deleted.</span>}
          </div>
          <div className="text-sm text-red-600 mb-4">
            This action cannot be undone. All project files will be permanently deleted.
          </div>
          <label className="block text-sm font-medium mb-2">
            Type <strong>{projectName}</strong> to confirm:
          </label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full"
            value={confirmName}
            onChange={e => setConfirmName(e.target.value)}
            placeholder={`Type ${projectName} to confirm`}
          />
          {error && <div className="text-sm text-red-600 mt-1">{error}</div>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
          <button
            className={`px-3 py-1 rounded ${error ? 'bg-gray-400 cursor-not-allowed' : 'bg-red-600 text-white'}`}
            onClick={handleDelete}
            disabled={!!error}
          >
            Delete Project
          </button>
        </div>
      </div>
    </div>
  );
}

function ServiceDeleteModal({path, svcName, onClose, onConfirm}){
  const [confirmText, setConfirmText] = useState('');
  const projectName = path.split('/').pop();
  const expected = `${projectName}/${svcName}`;
  const error = confirmText !== expected ? 'Value does not match' : '';

  function handleConfirm(){
    if (error) return;
    onConfirm(svcName);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold text-red-600">Delete Service</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="mb-4">
          <div className="text-sm text-gray-700 mb-2">
            Are you sure you want to delete the service <strong>{svcName}</strong> from project <strong>{projectName}</strong>?
          </div>
          <div className="text-sm text-red-600 mb-4">
            This action cannot be undone. The service will be removed from the compose locally (click Apply to persist).
          </div>
          <label className="block text-sm font-medium mb-2">
            Type <strong>{expected}</strong> to confirm:
          </label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            placeholder={`Type ${expected} to confirm`}
          />
          {error && <div className="text-sm text-red-600 mt-1">{error}</div>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
          <button
            className={`px-3 py-1 rounded ${error ? 'bg-gray-400 cursor-not-allowed' : 'bg-red-600 text-white'}`}
            onClick={handleConfirm}
            disabled={!!error}
          >
            Delete Service
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfigEditorModal({path, filename, onClose, onSave, showNotification}){
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState('text');
  const editorRef = React.useRef(null);
  const aceRef = React.useRef(null);

  useEffect(() => {
    loadConfig();
  }, [path, filename]);

  useEffect(() => {
    // Determine language based on file extension
    const ext = filename.split('.').pop().toLowerCase();
    switch(ext) {
      case 'sh':
      case 'bash':
        setLanguage('bash');
        break;
      case 'conf':
      case 'config':
        setLanguage('nginx'); // nginx syntax highlighting works well for conf files
        break;
      case 'js':
      case 'jsx':
        setLanguage('javascript');
        break;
      case 'json':
        setLanguage('json');
        break;
      case 'css':
        setLanguage('css');
        break;
      case 'html':
        setLanguage('html');
        break;
      default:
        setLanguage('text');
    }
  }, [filename]);

  async function loadConfig() {
    try {
      setLoading(true);
      const response = await axios.get('/api/config', { params: { path, filename } });
      setContent(response.data.content);
      setOriginalContent(response.data.content);
    } catch (e) {
      showNotification && showNotification('Failed to load config file: ' + ((e.response && e.response.data && e.response.data.error) || e.message), 'error');
      onClose();
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    try {
      setSaving(true);
      await axios.post('/api/save-config', { path, filename, content });
      setOriginalContent(content);
      showNotification && showNotification('Config file saved successfully', 'info');
    } catch (e) {
      showNotification && showNotification('Failed to save config file: ' + ((e.response && e.response.data && e.response.data.error) || e.message), 'error');
    } finally {
      setSaving(false);
    }
  }

  const hasChanges = content !== originalContent;

  // Initialize Ace editor when ready
  useEffect(() => {
    if (!editorRef.current) return;
    // if ace is not available, do nothing and fall back to textarea (already replaced)
    if (typeof window.ace === 'undefined') return;

    // create editor
    const ed = window.ace.edit(editorRef.current);
    aceRef.current = ed;
    ed.setTheme('ace/theme/chrome');
    ed.getSession().setMode('ace/mode/text');
    ed.setOptions({ fontSize: '14px', showPrintMargin: false, useWorker: false });
    ed.getSession().setTabSize(2);

    // sync from state to editor
    ed.setValue(content || '', -1);

    // on change, update content state
    const handler = () => setContent(ed.getValue());
    ed.getSession().on('change', handler);

    return () => {
      try { ed.getSession().off('change', handler); ed.destroy(); } catch (e) {}
      aceRef.current = null;
    };
  }, [editorRef.current]);

  // update ace mode when language changes
  useEffect(() => {
    if (!aceRef.current) return;
    const modeMap = {
      bash: 'ace/mode/sh', nginx: 'ace/mode/nginx', javascript: 'ace/mode/javascript',
      json: 'ace/mode/json', css: 'ace/mode/css', html: 'ace/mode/html', text: 'ace/mode/text'
    };
    const mode = modeMap[language] || 'ace/mode/text';
    aceRef.current.getSession().setMode(mode);
  }, [language]);

  // keep editor content in sync when content changes externally (load/save)
  useEffect(() => {
    if (aceRef.current) {
      const cur = aceRef.current.getValue();
      if (content !== cur) aceRef.current.setValue(content || '', -1);
    }
  }, [content]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded w-4/5 h-4/5 flex flex-col">
        <div className="flex justify-between items-center p-4 border-b">
          <div className="flex items-center gap-2">
            <div className="text-lg font-semibold">Edit Config: {filename}</div>
            <span className={`px-2 py-1 text-xs rounded ${
              language === 'bash' ? 'bg-yellow-100 text-yellow-800' :
              language === 'nginx' ? 'bg-green-100 text-green-800' :
              'bg-gray-100 text-gray-800'
            }`}>
              {language.toUpperCase()}
            </span>
          </div>
          <div className="flex gap-2">
            <button 
              className={`px-3 py-1 rounded ${hasChanges ? 'bg-blue-600 text-white' : 'bg-gray-400 cursor-not-allowed'}`}
              onClick={saveConfig}
              disabled={!hasChanges || saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Close</button>
          </div>
        </div>
        
        <div className="flex-1 p-4 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div>Loading...</div>
            </div>
          ) : (
            <div className="w-full h-full border rounded p-0">
              <div ref={editorRef} className="ace-editor" />
            </div>
          )}
        </div>
        
        <div className="p-2 bg-gray-50 border-t text-xs text-gray-600">
          {hasChanges ? 'You have unsaved changes' : 'No changes'}
        </div>
      </div>
    </div>
  );
}

function ConfigFilesModal({path, onClose, onEditConfig, showNotification}){
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConfigFiles();
  }, [path]);

  async function loadConfigFiles() {
    try {
      setLoading(true);
      const response = await axios.get('/api/config-files', { params: { path } });
      setFiles(response.data.files || []);
    } catch (e) {
      showNotification && showNotification('Failed to load config files: ' + ((e.response && e.response.data && e.response.data.error) || e.message), 'error');
    } finally {
      setLoading(false);
    }
  }

  function getFileIcon(extension) {
    switch(extension) {
      case '.sh':
      case '.bash':
        return '🐚';
      case '.conf':
      case '.config':
        return '⚙️';
      case '.js':
      case '.jsx':
        return '📄';
      case '.json':
        return '📋';
      case '.css':
        return '🎨';
      case '.html':
        return '🌐';
      default:
        return '📄';
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded w-2/3 max-h-3/4 overflow-hidden">
        <div className="flex justify-between items-center p-4 border-b">
          <div className="text-lg font-semibold">Config Files</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        
        <div className="p-4">
          {loading ? (
            <div className="text-center py-8">Loading config files...</div>
          ) : files.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No config files found</div>
          ) : (
            <div className="space-y-2">
              {files.map((file) => (
                <div key={file.name} className="flex items-center justify-between p-3 border rounded hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{getFileIcon(file.extension)}</span>
                    <div>
                      <div className="font-medium">{file.name}</div>
                      <div className="text-xs text-gray-500">
                        {file.size} bytes • Modified {new Date(file.modified).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <button 
                    className="px-3 py-1 bg-blue-600 text-white rounded text-sm"
                    onClick={() => onEditConfig && onEditConfig(path, file.name)}
                  >
                    Edit
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NotificationContainer({notifications, onRemove}){
  return (
    <div style={{position:'fixed', right:16, top:16, zIndex:9999}}>
      {notifications.map(n => (
        <div key={n.id} className={`mb-2 max-w-sm rounded shadow p-3 ${n.type==='error'?'bg-red-600 text-white':'bg-gray-800 text-white'}`}>
          <div className="flex justify-between items-start">
            <div style={{whiteSpace:'pre-wrap'}}>{n.message}</div>
            <button onClick={()=>onRemove(n.id)} className="ml-2 text-sm">✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ServiceEditor({svcName, svcData, onChange, onEditConfig, projectPath, availableImages = []}){
  // svcData.ports expected as array of strings or objects; normalize to objects { container, bind, host? }
  function normalizePorts(p){
    if (!p) return [];
    return p.map(item => {
      if (typeof item === 'string'){
        const parts = item.split(':');
        if (parts.length === 3){ // ip:host:container
          return { container: parts[2], host: parts[1], bind: parts[0] };
        }
        if (parts.length === 2){ // host:container
          return { container: parts[1], host: parts[0], bind: '0.0.0.0' };
        }
        return { container: parts[0], bind: '0.0.0.0' };
      }
      return item;
    });
  }

  const [ports, setPorts] = useState(normalizePorts(svcData.ports || []));
  const [networks, setNetworks] = useState(normalizeNetworks(svcData.networks || {}));
  const [availableNets, setAvailableNets] = useState([]);
  const [image, setImage] = useState(svcData.image || '');
  const [useCustomImage, setUseCustomImage] = useState(() => {
    const has = (svcData.image || '').trim();
    return has && !availableImages.includes(has);
  });
  const [volumes, setVolumes] = useState(Array.isArray(svcData.volumes) ? svcData.volumes.map(v=>String(v)) : []);
  // environmentInternal stores [{key:'FOO', value:'bar'}] for nicer UI editing
  const envToInternal = (env) => {
    if (!env) return [];
    if (Array.isArray(env)) return env.map(e=>{
      const s = String(e||'');
      const idx = s.indexOf('=');
      if (idx === -1) return { key: s, value: '' };
      return { key: s.slice(0, idx), value: s.slice(idx+1) };
    });
    if (typeof env === 'object') return Object.entries(env).map(([k,v])=>({ key: k, value: String(v) }));
    return [];
  };
  const internalToExternal = (arr) => arr.map(({key,value}) => (key? `${key}=${value}` : `${value}`));

  const [environment, setEnvironment] = useState(envToInternal(svcData.environment));
  const [restart, setRestart] = useState(svcData.restart || '');
  const [errors, setErrors] = useState({});
  const [dynamic, setDynamic] = useState({});

  useEffect(()=>{ 
    setPorts(normalizePorts(svcData.ports || [])); 
    setNetworks(normalizeNetworks(svcData.networks || {})); 
  setImage(svcData.image || '');
  setRestart(svcData.restart || '');
    setVolumes(Array.isArray(svcData.volumes) ? svcData.volumes.map(v=>String(v)) : []);
  setEnvironment(envToInternal(svcData.environment));
    // capture unknown keys for dynamic rendering
  const known = new Set(['ports','networks','image','volumes','environment','restart','status','tty']);
    const dyn = {};
    for (const [k,v] of Object.entries(svcData || {})){
      if (!known.has(k)) dyn[k] = v;
    }
    setDynamic(dyn);
    setErrors({}); 
  }, [svcData]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get('/api/networks');
        const nets = (r.data && r.data.networks) || [];
        // filter networks that have an IPAM.Config[0].Subnet
        const filtered = nets.map(n=>({ name: n.Name, subnet: (n.IPAM && n.IPAM.Config && n.IPAM.Config[0] && (n.IPAM.Config[0].Subnet || n.IPAM.Config[0].subnet)) || '' })).filter(x=>x.subnet && x.subnet.indexOf('/')!==-1);
        if (!cancelled) setAvailableNets(filtered);
      } catch (e) {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // call onChange only from user-driven handlers to avoid feedback loops
  function updatePort(i, field, v){
    const next = ports.map((p,idx)=> idx===i ? {...p, [field]: v} : p);
    setPorts(next); validatePorts(next);
  try { onChange({ ports: next, networks, image, volumes, environment: internalToExternal(environment) }); } catch(e){}
  }
  function addPort(){ const next = [...ports, { container: '', bind: '0.0.0.0', host: '' }]; setPorts(next); validatePorts(next); try { onChange({ ports: next, networks, environment: internalToExternal(environment) }); } catch(e){} }
  function removePort(i){ const next = ports.filter((_,k)=>k!==i); setPorts(next); validatePorts(next); try { onChange({ ports: next, networks, environment: internalToExternal(environment) }); } catch(e){} }

  // Single-network model: each service may only have one network mapping
  const [selectedNetName, setSelectedNetName] = useState('');

  function setSingleNetwork(name, ip){
    if (!name) {
      setNetworks({});
      setSelectedNetName('');
      try { onChange({ ports, networks: {}, image, volumes, environment: internalToExternal(environment) }); } catch(e){}
      return;
    }
    // replace any existing networks with the single selected one
    const next = { [name]: ip || '' };
    setNetworks(next);
    setSelectedNetName(name);
    try { onChange({ ports, networks: next, image, volumes, environment: internalToExternal(environment), restart }); } catch(e){}
  }

  async function fetchNextIpFor(name){
    if (!name) return;
    try {
      const r = await axios.get('/api/next-ip', { params: { network: name } });
      if (r && r.data && r.data.ip){
        setSingleNetwork(name, r.data.ip);
        return r.data.ip;
      }
    } catch (e) {
      // ignore
    }
    // fallback: set without ip
    setSingleNetwork(name, '');
    return null;
  }

  // Initialize selectedNetName from existing networks if present
  useEffect(()=>{
    const keys = Object.keys(networks || {});
    if (keys.length > 0) setSelectedNetName(keys[0]);
  }, []);
  

  // image/volumes/environment helpers
  function updateImage(v){ setImage(v); try { onChange({ ports, networks, image: v, volumes, environment: internalToExternal(environment) }); } catch(e){} }
  function updateRestart(v){ setRestart(v); try { onChange({ ports, networks, image, volumes, environment: internalToExternal(environment), restart: v }); } catch(e){} }
  function updateVolume(i, v){ const next = volumes.map((x,idx)=> idx===i ? v : x); setVolumes(next); try { onChange({ ports, networks, image, volumes: next, environment: internalToExternal(environment) }); } catch(e){} }
  function addVolume(){ const next = [...volumes, '']; setVolumes(next); try { onChange({ ports, networks, image, volumes: next, environment: internalToExternal(environment) }); } catch(e){} }
  function removeVolume(i){ const next = volumes.filter((_,k)=>k!==i); setVolumes(next); try { onChange({ ports, networks, image, volumes: next, environment: internalToExternal(environment) }); } catch(e){} }


  function updateEnvKey(i, key){ const next = environment.map((x,idx)=> idx===i ? {...x, key} : x); setEnvironment(next); try { onChange({ ports, networks, image, volumes, environment: internalToExternal(next) }); } catch(e){} }
  function updateEnvValue(i, value){ const next = environment.map((x,idx)=> idx===i ? {...x, value} : x); setEnvironment(next); try { onChange({ ports, networks, image, volumes, environment: internalToExternal(next) }); } catch(e){} }
  function addEnv(){ const next = [...environment, { key: '', value: '' }]; setEnvironment(next); try { onChange({ ports, networks, image, volumes, environment: internalToExternal(next) }); } catch(e){} }
  function removeEnv(i){ const next = environment.filter((_,k)=>k!==i); setEnvironment(next); try { onChange({ ports, networks, image, volumes, environment: internalToExternal(next) }); } catch(e){} }

  // dynamic fields handlers
  function updateDynamicKey(key, value){ const next = {...dynamic, [key]: value}; setDynamic(next); try { onChange({ [key]: value, ports, networks, image, volumes, environment: internalToExternal(environment) }); } catch(e){} }
  function addDynamicKey(key){ if (!key) return; const next = {...dynamic}; if (next[key] === undefined) next[key] = ''; setDynamic(next); try { onChange({ [key]: '', ports, networks, image, volumes, environment: internalToExternal(environment) }); } catch(e){} }
  function removeDynamicKey(key){ const next = {...dynamic}; delete next[key]; setDynamic(next); try { onChange({ [key]: undefined, ports, networks, image, volumes, environment: internalToExternal(environment) }); } catch(e){} }

  function validatePorts(list){
    const errs = {};
    list.forEach((p,i)=>{
      if (!p || !p.container || String(p.container).trim()==='') errs[i] = 'Container port required';
      else if (!/^\d+$/.test(String(p.container)) || Number(p.container)<=0 || Number(p.container)>65535) errs[i] = 'Invalid container port';
      else if (p.host && String(p.host).trim()!=='') {
        if (!/^\d+$/.test(String(p.host)) || Number(p.host)<=0 || Number(p.host)>65535) errs[i] = 'Invalid host port';
      }
    });
    setErrors(errs);
  }

  const valid = Object.keys(errors).length===0;

  return (
    <div className="border rounded p-3 bg-gray-50">
      <div className="flex justify-between items-center mb-2">
        <div className="font-semibold">{svcName}</div>
        {/* Rename service button only when stopped */}
        <div>
          <RenameServiceButton svcName={svcName} svcData={svcData} onRename={(newName)=>{
            if (!newName || newName.trim()===svcName) return;
            try { onChange({ renameService: { oldName: svcName, newName: newName.trim() } }); } catch(e){}
          }} />
        </div>
      </div>

      <div className="mb-3">
        <div className="text-sm text-gray-700">Image</div>
        {availableImages && availableImages.length > 0 && !useCustomImage ? (
          <div className="flex gap-2 items-center">
            <select className="border rounded px-2 py-1 w-full" value={availableImages.includes(image) ? image : ''} onChange={e=>{
              const val = e.target.value;
              if (val === '__custom__') { setUseCustomImage(true); return; }
              updateImage(val);
            }}>
              <option value="">Select image</option>
              {availableImages.map((img, i)=>(<option key={i} value={img}>{img}</option>))}
              <option value="__custom__">Other (type manually)...</option>
            </select>
          </div>
        ) : (
          <div className="flex gap-2 items-center">
            <input className="border rounded px-2 py-1 w-full" value={image} onChange={e=>updateImage(e.target.value)} placeholder="nginx:latest" />
            {availableImages && availableImages.length > 0 && (
              <button type="button" className="px-2 py-1 text-sm bg-gray-200 rounded" onClick={()=>setUseCustomImage(false)}>Select</button>
            )}
          </div>
        )}
      </div>
      <div className="mb-3">
        <div className="text-sm text-gray-700">Restart policy</div>
        <select className="border rounded px-2 py-1 w-full" value={restart} onChange={e=>updateRestart(e.target.value)}>
          <option value="">(none)</option>
          <option value="no">no</option>
          <option value="always">always</option>
          <option value="on-failure">on-failure</option>
          <option value="unless-stopped">unless-stopped</option>
        </select>
      </div>
      <div className="mb-2">
        <div className="text-sm text-gray-700">Ports</div>
        {ports.map((p,i)=> (
          <div key={i} className="flex gap-2 mt-1 items-center">
            <input className="border rounded px-2 py-1 w-24" value={p.container || ''} onChange={e=>updatePort(i, 'container', e.target.value)} placeholder="container" />
            <input className="border rounded px-2 py-1 w-24" value={p.host || ''} onChange={e=>updatePort(i, 'host', e.target.value)} placeholder="host (optional)" />
            <select value={p.bind || '0.0.0.0'} onChange={e=>updatePort(i, 'bind', e.target.value)} className="border rounded px-2 py-1">
              <option value="127.0.0.1">internal (127.0.0.1)</option>
              <option value="0.0.0.0">external (0.0.0.0)</option>
            </select>
            <button className="text-sm text-red-600" onClick={()=>removePort(i)}>Remove</button>
            {errors[i] && <div className="text-xs text-red-600">{errors[i]}</div>}
          </div>
        ))}
        <div className="mt-2">
          <button className="text-sm bg-green-600 text-white px-2 py-1 rounded" onClick={addPort}>Add port</button>
        </div>
      </div>

      <div className="mt-3">
        <div className="text-sm text-gray-700">Volumes</div>
        {volumes.map((v,i)=> {
          // parse volume mapping into host and container parts
          let hostPart = '';
          let containerPart = '';
          if (typeof v === 'string' && v.indexOf(':')!==-1){
            const idx = v.indexOf(':');
            hostPart = v.slice(0, idx);
            containerPart = v.slice(idx+1);
          } else if (typeof v === 'string') {
            // only container specified
            containerPart = v;
          }
          // heuristic: treat hostPart as a file if it contains a dot after last slash (e.g. /etc/nginx/conf.d/default.conf)
          const lastSlash = hostPart.lastIndexOf('/');
          const nameAfterSlash = lastSlash >= 0 ? hostPart.slice(lastSlash+1) : hostPart;
          const isHostFile = nameAfterSlash.indexOf('.') !== -1;

          return (
            <div key={i} className="flex gap-2 mt-1 items-center">
              <input className="border rounded px-2 py-1 w-1/2" value={hostPart} onChange={e=>{
                const nextHost = e.target.value;
                const next = volumes.map((x,idx)=> idx===i ? (nextHost + ':' + containerPart) : x);
                setVolumes(next); try { onChange({ ports, networks, image, volumes: next, environment }); } catch(e){}
              }} placeholder="host path or file (optional)" />
              <input className="border rounded px-2 py-1 w-1/2" value={containerPart} onChange={e=>{
                const nextContainer = e.target.value;
                const next = volumes.map((x,idx)=> idx===i ? ((hostPart?hostPart+':':'') + nextContainer) : x);
                setVolumes(next); try { onChange({ ports, networks, image, volumes: next, environment }); } catch(e){}
              }} placeholder="container path" />
              {isHostFile && hostPart && onEditConfig ? (
                <button className="px-2 py-1 bg-purple-600 text-white text-sm rounded" onClick={()=>{
                  // Provide projectPath and hostPart so the opener can resolve relative paths correctly
                  try { onEditConfig(projectPath, hostPart); } catch(e){ onEditConfig(hostPart); }
                }}>Edit File</button>
              ) : null}
              <button className="text-sm text-red-600" onClick={()=>removeVolume(i)}>Remove</button>
            </div>
          );
        })}
        <div className="mt-2"><button className="px-2 py-1 bg-green-600 text-white" onClick={addVolume}>Add volume</button></div>
      </div>

      <div className="mt-3">
        <div className="text-sm text-gray-700">Environment</div>
        {environment.map((env,i)=> (
          <div key={i} className="flex gap-2 mt-1 items-center">
            <input className="border rounded px-2 py-1 w-1/2" value={env.key} onChange={ev=>updateEnvKey(i, ev.target.value)} placeholder="KEY" />
            <input className="border rounded px-2 py-1 flex-1" value={env.value} onChange={ev=>updateEnvValue(i, ev.target.value)} placeholder="VALUE" />
            <button className="text-sm text-red-600" onClick={()=>removeEnv(i)}>Remove</button>
          </div>
        ))}
        <div className="mt-2"><button className="px-2 py-1 bg-green-600 text-white" onClick={addEnv}>Add env</button></div>
      </div>

      <div>
        <div className="text-sm text-gray-700">Network</div>
        <div className="flex gap-2 mt-1 items-center">
          <select className="border rounded px-2 py-1 w-48" value={selectedNetName} onChange={e=>{
            const name = e.target.value;
            // set selected network and try to fetch IP
            setSelectedNetName(name);
            if (name) fetchNextIpFor(name);
            else setSingleNetwork('', '');
          }}>
            <option value="">(none)</option>
            {availableNets.map((n,idx)=> (
              <option key={idx} value={n.name}>{n.name}{n.subnet?` (${n.subnet})`:''}</option>
            ))}
          </select>

          <input className="border rounded px-2 py-1 flex-1" value={ (selectedNetName && networks && networks[selectedNetName]) ? networks[selectedNetName] : '' } onChange={e=>{
            const ip = e.target.value;
            if (!selectedNetName) return;
            setSingleNetwork(selectedNetName, ip);
          }} placeholder="ipv4 address" />

          
          {selectedNetName ? <button className="text-sm text-red-600" onClick={()=>setSingleNetwork('', '')}>Remove</button> : null}
        </div>
      </div>

      <div className="mt-3 text-sm text-gray-600">Validation: {valid ? <span className="text-green-600">OK</span> : <span className="text-red-600">Errors</span>}</div>
      {Object.keys(dynamic || {}).length > 0 && (
        <div className="mt-4 border-t pt-3">
          <div className="font-medium mb-2">Other fields</div>
          {Object.entries(dynamic).map(([k,v])=> (
            <div key={k} className="mb-2">
              <div className="text-sm text-gray-700">{k}</div>
              {Array.isArray(v) ? (
                <div className="space-y-1">
                  {v.map((it,idx)=>(<div key={idx} className="flex gap-2 items-center"><input className="border px-2 py-1 flex-1" value={String(it||'')} onChange={e=>{ const copy = Array.from(v); copy[idx]=e.target.value; updateDynamicKey(k, copy); }} /><button className="text-red-600" onClick={()=>{ const copy = Array.from(v); copy.splice(idx,1); updateDynamicKey(k, copy); }}>Remove</button></div>))}
                  <div><button className="px-2 py-1 bg-green-600 text-white" onClick={()=>{ const copy = Array.from(v||[]); copy.push(''); updateDynamicKey(k, copy); }}>Add</button></div>
                </div>
              ) : (typeof v === 'object' && v !== null) ? (
                <div className="space-y-1">
                  {Object.entries(v).map(([subk, subv])=>(<div key={subk} className="flex gap-2 items-center"><div className="w-40 text-sm text-gray-600">{subk}</div><input className="border px-2 py-1 flex-1" value={String(subv||'')} onChange={e=>{ const copy = {...v}; copy[subk]=e.target.value; updateDynamicKey(k, copy); }} /></div>))}
                </div>
              ) : (
                <input className="border px-2 py-1 w-full" value={String(v||'')} onChange={e=>updateDynamicKey(k, e.target.value)} />
              )}
              <div className="text-xs text-gray-500 mt-1"><button className="text-red-600" onClick={()=>removeDynamicKey(k)}>Remove field</button></div>
            </div>
          ))}
          <div className="mt-2">
            <input placeholder="new field name" id={`new-dyn-${svcName}`} className="border px-2 py-1 mr-2" />
            <button className="px-2 py-1 bg-green-600 text-white" onClick={()=>{ const val = document.getElementById(`new-dyn-${svcName}`).value; if (val) addDynamicKey(val); }}>Add field</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RenameServiceButton({svcName, svcData, onRename}){
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(svcName);
  const status = svcData && svcData.status;

  function handleConfirm(){
    if (!name || name.trim()===svcName) return;
    onRename(name.trim());
    setOpen(false);
  }

  return (
    <div>
      <button className={`px-2 py-1 rounded text-sm mr-2 ${status==='stopped' ? 'bg-yellow-600 text-white' : 'bg-gray-300 text-white cursor-not-allowed'}`} onClick={()=>{ if (status==='stopped') setOpen(true); }} disabled={status!=='stopped'} title={status!=='stopped' ? 'Service must be stopped to rename' : ''}>Rename</button>
      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded w-1/3 p-4">
            <div className="flex justify-between items-center mb-4">
              <div className="text-lg font-semibold">Rename Service</div>
              <button className="text-sm text-gray-600" onClick={()=>setOpen(false)}>Close</button>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">New Service Name</label>
              <input type="text" className="border rounded px-3 py-2 w-full" value={name} onChange={e=>setName(e.target.value)} />
            </div>
            <div className="flex gap-2 justify-end">
              <button className="px-3 py-1 bg-gray-200 rounded" onClick={()=>setOpen(false)}>Cancel</button>
              <button className={`px-3 py-1 rounded ${!name.trim() || name.trim()===svcName ? 'bg-gray-400 cursor-not-allowed' : 'bg-yellow-600 text-white'}`} onClick={handleConfirm} disabled={!name.trim() || name.trim()===svcName}>Rename</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper to render dynamic fields for unknown keys
function DynamicFields({svcData, onDynamicChange}){
  // produce a list of keys excluding the ones we already render explicitly
  const explicit = new Set(['ports','networks','image','volumes','environment']);
  const keys = Object.keys(svcData || {}).filter(k=>!explicit.has(k));
  if (keys.length===0) return null;

  function updateKey(key, val){
    const next = Object.assign({}, svcData, { [key]: val });
    onDynamicChange(next);
  }

  return (
    <div className="mt-3">
      <div className="font-medium mb-2">Other fields</div>
      {keys.map((k)=>{
        const v = svcData[k];
        if (Array.isArray(v)){
          return (
            <div key={k} className="mb-2">
              <div className="text-sm text-gray-700">{k} (array)</div>
              {v.map((item,idx)=> (
                <div key={idx} className="flex gap-2 items-center mt-1">
                  <input className="border px-2 py-1 flex-1" value={String(item||'')} onChange={e=>{ const next = [...v]; next[idx]=e.target.value; updateKey(k, next); }} />
                  <button className="text-sm text-red-600" onClick={()=>{ const next = v.filter((_,i)=>i!==idx); updateKey(k, next); }}>Remove</button>
                </div>
              ))}
              <div className="mt-1"><button className="px-2 py-1 bg-green-600 text-white" onClick={()=>{ const next = [...v, '']; updateKey(k, next); }}>Add</button></div>
            </div>
          );
        }
        if (v && typeof v === 'object'){
          // render as key/value pairs
          const entries = Object.entries(v);
          return (
            <div key={k} className="mb-2">
              <div className="text-sm text-gray-700">{k} (object)</div>
              {entries.map(([ek,ev],ei)=> (
                <div key={ei} className="flex gap-2 items-center mt-1">
                  <input className="border px-2 py-1 w-40" value={ek} onChange={e=>{ const next = {...v}; const newKey = e.target.value; delete next[ek]; next[newKey]=ev; updateKey(k, next); }} />
                  <input className="border px-2 py-1 flex-1" value={String(ev||'')} onChange={e=>{ const next = {...v}; next[ek]=e.target.value; updateKey(k, next); }} />
                  <button className="text-sm text-red-600" onClick={()=>{ const next = {...v}; delete next[ek]; updateKey(k, next); }}>Remove</button>
                </div>
              ))}
              <div className="mt-1">
                <button className="px-2 py-1 bg-green-600 text-white" onClick={()=>{ const next = {...v}; let idx=0; while(next['key'+idx]) idx++; next['key'+idx]=''; updateKey(k, next); }}>Add field</button>
              </div>
            </div>
          );
        }
        // primitives
        return (
          <div key={k} className="mb-2">
            <div className="text-sm text-gray-700">{k}</div>
            <input className="border px-2 py-1 w-full" value={String(v||'')} onChange={e=>updateKey(k, e.target.value)} />
          </div>
        );
      })}
    </div>
  );
}

function EditorModal({path, data, onClose, onApply, onEditConfig, showNotification, availableImages = []}){
  const [local, setLocal] = useState(JSON.parse(JSON.stringify(data)));
  const [dirty, setDirty] = useState(false);
  const [statusMap, setStatusMap] = useState({});
  const [addServiceOpen, setAddServiceOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState(null);
  // baselineRef holds the last-applied services snapshot used for diffing
  const baselineRef = React.useRef(JSON.parse(JSON.stringify(data.services || {})));

  // if parent `data.services` updates (external refresh), update baselineRef to match
  useEffect(() => { baselineRef.current = JSON.parse(JSON.stringify(data.services || {})); }, [data.services]);
  // logsModal removed: terminal popup provides realtime output

  useEffect(()=>{
    // fetch status for each service and refresh periodically so modal shows realtime status
    let cancelled = false;
    async function fetchAll(){
      const res = {};
      for (const svc of Object.keys(local.services||{})){
        try {
          const r = await axios.get('/api/status', { params: { path, service: svc } });
          res[svc] = r.data;
        } catch(e){
          res[svc] = { error: String(e) };
        }
      }
      if (!cancelled) setStatusMap(res);
    }

    fetchAll();
    const iv = setInterval(fetchAll, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [path, local.services]);

  // helper: poll /api/status until the service reaches a non-transient state or timeout
  async function waitForStatus(svc, opts = { interval: 800, timeout: 15000 }){
    const start = Date.now();
    while (Date.now() - start < opts.timeout){
      try {
        const r = await axios.get('/api/status', { params: { path, service: svc } });
        const d = r.data || {};
        const st = d.status || (d.running === true ? 'running' : (d.running === false ? 'stopped' : undefined));
        if (st && st !== 'restarting' && st !== 'stopping') return d;
        // if status present but transient, continue polling
      } catch(e) {
        // ignore transient errors and continue polling
      }
      await new Promise(res => setTimeout(res, opts.interval));
    }
    // final attempt to read status before giving up
    try { const r = await axios.get('/api/status', { params: { path, service: svc } }); return r.data; } catch(e) { return { error: String(e) }; }
  }

  function updateService(svcName, changes){
  // handle rename instruction specially
  if (changes && changes.renameService) {
    const { oldName, newName } = changes.renameService;
    if (!oldName || !newName) return;
    const next = {...local};
    next.services = { ...next.services };
    // if oldName exists and newName not present, perform rename
    if (next.services[oldName] && !next.services[newName]){
      next.services[newName] = next.services[oldName];
      delete next.services[oldName];
    }
    const changed = getChangedServicesBetween(baselineRef.current || {}, next.services || {});
    setLocal(next);
    setDirty(changed.length > 0);
    return;
  }

  const next = {...local, services:{...local.services, [svcName]:{...local.services[svcName], ...changes}}};
  // set dirty only if actual value changed compared to baseline snapshot
  const changed = getChangedServicesBetween(baselineRef.current || {}, next.services || {});
  setLocal(next);
  setDirty(changed.length > 0);
  }

  function requestDeleteService(svcName){
    // open confirmation modal which requires typing project/service
    setServiceToDelete(svcName);
  }

  function confirmDeleteService(svcName){
    const next = {...local};
    if (next.services) delete next.services[svcName];
  const changed = getChangedServicesBetween(baselineRef.current || {}, next.services || {});
  setLocal(next);
  setDirty(changed.length > 0);
    showNotification && showNotification(`Service "${svcName}" deleted locally. Persisting changes...`, 'info');
    // persist deletion immediately by invoking onApply with the updated services
    (async () => {
      try {
        await onApply(next);
        // update baseline snapshot on success
        baselineRef.current = JSON.parse(JSON.stringify(next.services || {}));
        setDirty(false);
        showNotification && showNotification(`Service "${svcName}" deleted.`, 'info');
      } catch (e) {
        showNotification && showNotification('Failed to persist deletion: ' + ((e && e.message) || String(e)), 'error');
      }
    })();
    setServiceToDelete(null);
  }

  async function apply(){
    // simple validation: ports format and ip format
    for (const [svc,info] of Object.entries(local.services||{})){
      // ports may be strings (legacy) or objects {container, bind, host}
      for (const p of (info.ports||[])){
        if (!p) { showNotification && showNotification('Empty port entry in '+svc, 'error'); return; }
        if (typeof p === 'string'){
          if (!isPortMapping(p)) { showNotification && showNotification('Invalid port mapping in '+svc+': '+p, 'error'); return; }
        } else if (typeof p === 'object'){
          const container = String(p.container || '').trim();
          if (!container) { showNotification && showNotification('Missing container port in '+svc, 'error'); return; }
          if (!/^\d+$/.test(container) || Number(container)<=0 || Number(container)>65535) { showNotification && showNotification('Invalid container port in '+svc+': '+container, 'error'); return; }
          const bind = p.bind || '';
          if (bind && bind !== '0.0.0.0' && bind !== '127.0.0.1' && !isIpv4(bind)) { showNotification && showNotification('Invalid bind address in '+svc+': '+bind, 'error'); return; }
        } else {
          showNotification && showNotification('Unsupported port entry in '+svc, 'error'); return;
        }
      }
      for (const [k,v] of Object.entries(info.networks||{})){
        if (typeof v === 'string'){
          if (v.trim() !== '' && !isIpv4(v)){
            // allow non-ip network names (no further validation)
          }
        } else if (v && typeof v === 'object'){
          // network may already be an object with ipv4_address
          const ip = v.ipv4_address || v.ipv4Address || '';
          if (ip && !isIpv4(ip)) { showNotification && showNotification('Invalid network IP in '+svc+': '+ip, 'error'); return; }
        }
      }
    }
    try {
  await onApply(local);
  // On successful apply, update baseline snapshot to current local.services and clear dirty
  baselineRef.current = JSON.parse(JSON.stringify(local.services || {}));
  setDirty(false);
    } catch (e) {
      // onApply already shows notification; abort restart
      return;
    }
  // Changes applied. Do not automatically restart services here.
  showNotification && showNotification('Apply completed. Services were not restarted automatically.', 'info');
  }

  function openAddService(){ setAddServiceOpen(true); }
  function closeAddService(){ setAddServiceOpen(false); }

  function addNewService(svc) {
    // svc: { name, image, ports:[], volumes:[], environment:[] }
    if (!svc || !svc.name) { showNotification && showNotification('Invalid service', 'error'); return; }
    if (!local.services) local.services = {};
    if (local.services[svc.name]) { showNotification && showNotification('Service name already exists', 'error'); return; }
    // normalize arrays
    const normalizeArray = (arr) => (arr && Array.isArray(arr)) ? arr.filter(x=>x && String(x).trim()!=='') : [];
  local.services[svc.name] = {
      image: svc.image || '',
      ports: normalizeArray(svc.ports),
      volumes: normalizeArray(svc.volumes),
      environment: (svc.environment || []).filter(e=>e && String(e).trim()!==''),
      networks: {}
    };
  const next = {...local};
  const changed = getChangedServicesBetween(baselineRef.current || {}, next.services || {});
  setLocal(next);
  setDirty(changed.length > 0);
    setAddServiceOpen(false);
    showNotification && showNotification('Service added locally. Click Apply changes to persist.', 'info');
  }

  // helper: compare two service maps and return list of service names that differ
  function getChangedServicesBetween(orig, cur){
    const changed = [];
    const o = orig || {};
    const c = cur || {};
    // services added or removed
    for (const s of Object.keys(c)) if (!o[s]) changed.push(s);
    for (const s of Object.keys(o)) if (!c[s]) changed.push(s);
    // services still present: compare shallow keys that matter (image, ports, volumes, environment, networks)
    const keys = ['image','ports','volumes','environment','networks'];
    for (const s of Object.keys(c)){
      if (!o[s]) continue;
      for (const k of keys){
        const a = JSON.stringify(o[s][k] || null);
        const b = JSON.stringify(c[s][k] || null);
        if (a !== b){ changed.push(s); break; }
      }
    }
    return Array.from(new Set(changed));
  }

  // compute which services were changed compared to original data (convenience wrapper)
  function getChangedServices(){
    return getChangedServicesBetween(baselineRef.current || {}, local.services || {});
  }

  // Determine disabled state for Apply button
  const changedServices = getChangedServices();
  const anyChanged = changedServices.length > 0 || dirty;
  // If no changes at all, the Apply button should be disabled by default
  // Also, if any of the changed services is currently running (according to data.services/statusMap), disable Apply
  const isAnyChangedServiceRunning = changedServices.some(svc => {
    // prefer statusMap (fresh status), fall back to data.services
    const st = (statusMap && statusMap[svc] && statusMap[svc].status) || (data.services && data.services[svc] && data.services[svc].status) || '';
    return st === 'running' || st === 'restarting' || st === 'stopping';
  });

  const applyDisabled = !anyChanged || isAnyChangedServiceRunning;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
  {addServiceOpen && <AddServiceModal onClose={closeAddService} onAdd={addNewService} existingNames={Object.keys(local.services||{})} />}
  {/* logsModal removed: terminal popup provides realtime output */}
      <div className="bg-white rounded w-3/4 max-h-[80vh] overflow-auto p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold">Edit {path}</div>
          <div className="flex gap-2">
            <button className="px-3 py-1 bg-green-600 text-white rounded text-sm" onClick={openAddService}>Add Service</button>
            <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
          </div>
        </div>

        {Object.entries(local.services||{}).map(([svc,info])=> (
          <div key={svc} className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <div className="font-medium">{svc}</div>
              <div className="flex gap-2 items-center">
                {(() => {
                  // NOTE: prefer `statusMap` for transient states (stopping/restarting).
                  // When a transient state is set (e.g. after clicking Stop), the Start/Stop
                  // button is disabled until the backend returns the final status. This
                  // mirrors the existing behavior used for restarts and improves UX.
                  // Prefer fresh transient state from statusMap when available, fall back to data.services
                  const svcEntry = (statusMap && statusMap[svc]) || (data.services && data.services[svc]) || {};
                  let computedStatus = svcEntry.status || undefined;
                  if (!computedStatus) {
                    if (svcEntry.restarting) computedStatus = 'restarting';
                    else if (svcEntry.stopping) computedStatus = 'stopping';
                    else if (svcEntry.running === true) computedStatus = 'running';
                    else if (svcEntry.running === false) computedStatus = 'stopped';
                  }
                  if (!computedStatus) computedStatus = 'stopped';

                  const isRunning = computedStatus === 'running';
                  const isTransient = computedStatus === 'stopping' || computedStatus === 'restarting';

                  return (
                    <div className="flex gap-2 items-center">
                      <div className="text-sm text-gray-600">Status: {
                        computedStatus === 'restarting' ? <span className="text-yellow-600">restarting...</span> :
                        computedStatus === 'stopping' ? <span className="text-orange-600">stopping...</span> :
                        computedStatus === 'running' ? <span className="text-green-600">running</span> :
                        <span className="text-red-600">stopped</span>
                      }</div>
                      <button
                        className={`px-2 py-1 rounded ${isRunning ? 'bg-gray-700 text-white' : 'bg-yellow-500 text-white'} ${isTransient ? 'opacity-60 cursor-not-allowed' : ''}`}
                        onClick={async () => {
                          if (isTransient) return; // ignore clicks while transient
                          if (isRunning) {
                            // stop flow (optimistic UI + terminal)
                            setStatusMap({ ...statusMap, [svc]: { stopping: true } });
                            try {
                              try {
                                const url = '/terminal.html?' + new URLSearchParams({ file: path, service: svc, action: 'stop' }).toString();
                                const win = window.open(url, '_blank', 'width=800,height=400,noopener');
                                if (!win) console.warn('Popup blocked: unable to open terminal window');
                              } catch (e) { console.warn('could not open terminal window', e); }
                              await axios.post('/api/stop', { path, service: svc });
                              // wait for final state (not 'stopping'/'restarting')
                              const final = await waitForStatus(svc);
                              setStatusMap({ ...statusMap, [svc]: final });
                            } catch (e) {
                              setStatusMap({ ...statusMap, [svc]: { running: false } });
                              console.warn('stop failed', e);
                            }
                          } else {
                            // start/restart flow (optimistic UI + terminal)
                            setStatusMap({ ...statusMap, [svc]: { restarting: true } });
                            try {
                              try {
                                const url = '/terminal.html?' + new URLSearchParams({ file: path, service: svc, action: 'restart' }).toString();
                                const win = window.open(url, '_blank', 'width=800,height=400,noopener');
                                if (!win) console.warn('Popup blocked: unable to open terminal window');
                              } catch (e) { console.warn('could not open terminal window', e); }
                              await axios.post('/api/restart', { path, service: svc });
                              // wait for final state (not 'stopping'/'restarting')
                              const final = await waitForStatus(svc);
                              setStatusMap({ ...statusMap, [svc]: final });
                            } catch (e) {
                              setStatusMap({ ...statusMap, [svc]: { running: false } });
                              console.warn('start/restart failed', e);
                            }
                          }
                        }}
                        disabled={isTransient}
                      >
                        {isRunning ? 'Stop' : 'Start'}
                      </button>
                    </div>
                  );
                })()}
                <button className="px-2 py-1 bg-teal-600 text-white rounded" onClick={()=>{
                  // open inspect popup: show past logs then run up in foreground
                  try {
                    const url = '/terminal.html?' + new URLSearchParams({ file: path, service: svc, action: 'inspect' }).toString();
                    const win = window.open(url, '_blank', 'width=900,height=500,noopener');
                    if (!win) console.warn('Popup blocked: unable to open inspect terminal window');
                  } catch(e){ console.warn('open inspect failed', e); }
                }}>Inspect</button>
                {/* Log: show only when service has a static IPv4 in networks */}
                {(() => {
                  let ip = '';
                  try {
                    const nets = (info && info.networks) ? Object.values(info.networks) : [];
                    if (nets && nets.length > 0) {
                      const first = nets[0];
                      if (typeof first === 'string') ip = first;
                      else if (first && typeof first === 'object') ip = first.ipv4_address || first.ipv4Address || '';
                    }
                  } catch (e) {}
                  const hasIp = ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip);
                  if (!hasIp) return null;
                  return (
                    <button className="px-2 py-1 bg-sky-600 text-white rounded" onClick={() => {
                      try {
                        const url = '/terminal.html?' + new URLSearchParams({ file: path, service: svc, action: 'log', ip }).toString();
                        const win = window.open(url, '_blank', 'width=900,height=500,noopener');
                        if (!win) console.warn('Popup blocked: unable to open log window');
                      } catch (e) { console.warn('open log failed', e); }
                    }}>Log</button>
                  );
                })()}
                <button 
                  className={`px-2 py-1 rounded ${(data.services && data.services[svc] && data.services[svc].status === 'running') ? 'bg-indigo-600 text-white' : 'bg-gray-400 text-white cursor-not-allowed'}`} 
                  onClick={()=>{
                    // open terminal for this specific service
                    try {
                      const url = '/terminal.html?' + new URLSearchParams({ file: path, service: svc }).toString();
                      const win = window.open(url, '_blank', 'noopener');
                      if (!win) console.warn('Popup blocked: unable to open terminal window');
                    } catch(e) { console.warn('attach failed', e); }
                  }}
                  disabled={!(data.services && data.services[svc] && data.services[svc].status === 'running')}
                >
                  Attach
                </button>
                {/* Restart: only show when service is running. This will perform stop, wait for stopped, then start. */}
                {((statusMap && statusMap[svc] && statusMap[svc].status === 'running') || (data.services && data.services[svc] && data.services[svc].status === 'running')) && (
                  <button
                    className={`px-2 py-1 rounded bg-purple-600 text-white ${((statusMap && statusMap[svc] && (statusMap[svc].stopping || statusMap[svc].restarting)) || (data.services && data.services[svc] && (data.services[svc].status==='stopping' || data.services[svc].status==='restarting'))) ? 'opacity-60 cursor-not-allowed' : ''}`}
                    onClick={async () => {
                      // prevent clicks while transient
                      const transient = (statusMap && statusMap[svc] && (statusMap[svc].stopping || statusMap[svc].restarting)) || (data.services && data.services[svc] && (data.services[svc].status==='stopping' || data.services[svc].status==='restarting'));
                      if (transient) return;
                      // optimistic: mark stopping
                      setStatusMap({ ...statusMap, [svc]: { stopping: true } });
                      try {
                        try {
                          const url = '/terminal.html?' + new URLSearchParams({ file: path, service: svc, action: 'stop' }).toString();
                          const win = window.open(url, '_blank', 'width=800,height=400,noopener');
                          if (!win) console.warn('Popup blocked: unable to open terminal window');
                        } catch (e) { console.warn('could not open terminal window', e); }
                        await axios.post('/api/stop', { path, service: svc });
                      } catch (e) {
                        setStatusMap({ ...statusMap, [svc]: { running: false } });
                        console.warn('stop part of restart failed', e);
                        return;
                      }
                      // wait until not transient
                      const afterStop = await waitForStatus(svc);
                      setStatusMap({ ...statusMap, [svc]: afterStop });

                      // small delay to allow auto-apply or backend propagation to complete
                      // (helps avoid immediate start racing with apply that may recreate files)
                      const delayMs = 1200;
                      await new Promise(res => setTimeout(res, delayMs));

                      // now start
                      setStatusMap({ ...statusMap, [svc]: { restarting: true } });
                      try {
                        try {
                          const url = '/terminal.html?' + new URLSearchParams({ file: path, service: svc, action: 'restart' }).toString();
                          const win = window.open(url, '_blank', 'width=800,height=400,noopener');
                          if (!win) console.warn('Popup blocked: unable to open terminal window');
                        } catch (e) { console.warn('could not open terminal window', e); }
                        await axios.post('/api/restart', { path, service: svc });
                        const final = await waitForStatus(svc);
                        setStatusMap({ ...statusMap, [svc]: final });
                      } catch (e) {
                        setStatusMap({ ...statusMap, [svc]: { running: false } });
                        console.warn('start part of restart failed', e);
                      }
                    }}
                  >
                    Restart
                  </button>
                )}
                {/* Stop logic merged into Start/Stop toggle above */}
                <button 
                  className={`px-2 py-1 rounded ${(data.services && data.services[svc] && data.services[svc].status === 'stopped') ? 'bg-red-600 text-white' : 'bg-gray-400 text-white cursor-not-allowed'}`} 
                  onClick={()=>requestDeleteService(svc)}
                  disabled={!(data.services && data.services[svc] && data.services[svc].status === 'stopped')}
                  title={!(data.services && data.services[svc] && data.services[svc].status === 'stopped') ? 'Service must be stopped to delete' : ''}
                >
                  Delete
                </button>
              </div>
            </div>
            <ServiceEditor svcName={svc} svcData={info} onChange={(changes)=>updateService(svc, changes)} onEditConfig={onEditConfig} projectPath={path} availableImages={availableImages} />
          </div>
        ))}

  <EditorAutoApplyControls applyDisabled={applyDisabled} apply={apply} onClose={onClose} anyChanged={anyChanged} isAnyChangedServiceRunning={isAnyChangedServiceRunning} />
    {serviceToDelete && <ServiceDeleteModal path={path} svcName={serviceToDelete} onClose={()=>setServiceToDelete(null)} onConfirm={confirmDeleteService} />}
      </div>
    </div>
  );
}

// show AddServiceModal from EditorModal
// The modal is inserted at top-level rendering in App; to keep changes small, render AddServiceModal conditionally by
// mounting it near where EditorModal is used in App (handled below).

function AddServiceModal({onClose, onAdd, existingNames = []}){
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');

  function updateAt(arr, i, v, setter){ const copy = [...arr]; copy[i]=v; setter(copy); }
  function addEmpty(arr, setter){ setter([...arr, '']); }
  function removeAt(arr, i, setter){ setter(arr.filter((_,k)=>k!==i)); }

  useEffect(() => {
    checkAvailability(name);
  }, [name, existingNames]);

  function checkAvailability(n){
    if (!n.trim()) { setError(''); return; }
    const exists = (existingNames || []).some(s => String(s||'') === n.trim());
    if (exists) setError('Name already exists'); else setError('');
  }

  function collect(){
    return { name: String(name||'').trim(), image: String(image||'').trim(), ports: [], volumes: [], environment: [] };
  }

  function handleAdd(){
    const svc = collect();
    if (!svc.name || error) return;
    onAdd(svc);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold">Add New Service</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm mb-1">Service Name</label>
            <input className="border px-2 py-1 w-full" value={name} onChange={e=>setName(e.target.value)} />
            {error && <div className="text-sm text-red-600 mt-1">{error}</div>}
          </div>
          <div>
            <label className="block text-sm mb-1">Docker Image</label>
            <input className="border px-2 py-1 w-full" value={image} onChange={e=>setImage(e.target.value)} placeholder="nginx:latest" />
          </div>
          <div className="text-sm text-gray-600">Only name and image are required here. Volumes, ports and environment can be edited later per-service in the editor.</div>
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
          <button className={`px-3 py-1 rounded ${error || !name.trim() ? 'bg-gray-400 text-white cursor-not-allowed' : 'bg-blue-600 text-white'}`} onClick={handleAdd} disabled={!!error || !name.trim()}>Add Service</button>
        </div>
      </div>
    </div>
  );
}

function EditorAutoApplyControls({ applyDisabled, apply, onClose, anyChanged, isAnyChangedServiceRunning }){
  const [autoApply, setAutoApply] = useState(false);

  // initialize from localStorage
  useEffect(()=>{
    try {
      const v = localStorage.getItem('autoApplyEnabled');
      if (v !== null) setAutoApply(v === 'true');
    } catch(e){}
  }, []);

  // when autoApply enabled and apply becomes available, trigger apply()
  useEffect(()=>{
    if (autoApply && !applyDisabled) {
      try { apply(); } catch(e) { console.warn('auto-apply failed', e); }
    }
  }, [autoApply, applyDisabled]);

  return (
    <div className="flex gap-2 justify-end mt-4 items-center">
      <div className="flex items-center gap-2 mr-4">
        <label className="flex items-center gap-2 text-sm">
          <span className={`relative inline-block w-10 mr-2 align-middle select-none transition duration-200 ease-in`}> 
            <input type="checkbox" checked={autoApply} onChange={e=>{ const val = e.target.checked; setAutoApply(val); try { localStorage.setItem('autoApplyEnabled', val ? 'true' : 'false'); } catch(e){} }} className="absolute opacity-0 w-0 h-0" />
            <span className={`block w-10 h-5 rounded-full ${autoApply ? 'bg-blue-600' : 'bg-gray-300'}`} />
            <span className={`dot absolute left-1 top-0.5 w-4 h-4 bg-white rounded-full transition ${autoApply ? 'translate-x-5' : ''}`} />
          </span>
          Auto-apply
        </label>
      </div>
      <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
      <button
        className={`px-3 py-1 rounded ${applyDisabled ? 'bg-gray-400 text-white cursor-not-allowed' : 'bg-blue-600 text-white'}`}
        onClick={apply}
        disabled={applyDisabled}
        title={
          !anyChanged ? 'No changes to apply' : (isAnyChangedServiceRunning ? 'Stop affected running services before applying changes' : 'Apply changes')
        }
      >
        Apply changes
      </button>
    </div>
  );
}

function LogsModal({title, logs, onClose}){
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded w-3/4 h-3/4 flex flex-col">
        <div className="flex justify-between items-center p-4 border-b">
          <div className="text-lg font-semibold">{title}</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="flex-1 p-4 overflow-auto">
          <pre className="bg-gray-100 p-4 rounded text-sm font-mono whitespace-pre-wrap">{logs}</pre>
        </div>
      </div>
    </div>
  );
}

function AddProjectModal({onClose, onAdd, mapper}){
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    checkAvailability(name);
  }, [name, mapper]);

  function checkAvailability(n) {
    if (!n.trim()) {
      setError('');
      return;
    }
    const folderName = n.trim();
    const exists = Object.keys(mapper).some(path => path.split('/').pop() === folderName);
    if (exists) {
      setError('Name is not available');
    } else {
      setError('');
    }
  }

  function handleAdd() {
    if (!name.trim() || error) return;
    onAdd(name.trim());
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold">Add New Project</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Project Name</label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Enter project name"
          />
          {error && <div className="text-sm text-red-600 mt-1">{error}</div>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
          <button
            className={`px-3 py-1 rounded ${error || !name.trim() ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-600 text-white'}`}
            onClick={handleAdd}
            disabled={error || !name.trim()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteImageModal({imageName, onClose, onDelete}){
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [output, setOutput] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const error = confirmName !== imageName ? 'Name does not match' : '';

  async function handleDelete() {
    if (error || deleting) return;
    setDeleting(true);
    setOutput('');
    setShowOutput(true);
    
    try {
      // Call the delete function and capture output
      const result = await onDelete(imageName);
      setOutput((result && result.output) || 'Image deleted successfully');
    } catch (e) {
      setOutput('Error: ' + ((e && e.response && e.response.data && e.response.data.error) || (e && e.message) || String(e)));
    } finally {
      setDeleting(false);
    }
  }

  if (showOutput) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
        <div className="bg-white rounded w-3/4 max-w-2xl p-4">
          <div className="flex justify-between items-center mb-4">
            <div className="text-lg font-semibold">Deleting Image: {imageName}</div>
            <button className="text-sm text-gray-600" onClick={()=>{setShowOutput(false); onClose();}}>Close</button>
          </div>
          <div className="mb-4">
              <div className="bg-gray-100 border rounded p-3 font-mono text-sm max-h-96 overflow-y-auto modal-pre">
              <pre className="modal-pre">{output}</pre>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button className="px-3 py-1 bg-gray-200 rounded" onClick={()=>{setShowOutput(false); onClose();}}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold text-red-600">Delete Image</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="mb-4">
          <div className="text-sm text-gray-700 mb-2">
            Are you sure you want to delete the image <strong>{imageName}</strong>?
          </div>
          <div className="text-sm text-red-600 mb-4">
            This action cannot be undone. The image will be permanently deleted if not in use.
          </div>
          <label className="block text-sm font-medium mb-2">
            Type <strong>{imageName}</strong> to confirm:
          </label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full"
            value={confirmName}
            onChange={e => setConfirmName(e.target.value)}
            placeholder={`Type ${imageName} to confirm`}
          />
          {error && <div className="text-sm text-red-600 mt-1">{error}</div>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
          <button
            className={`px-3 py-1 rounded ${error || deleting ? 'bg-gray-400 cursor-not-allowed' : 'bg-red-600 text-white'}`}
            onClick={handleDelete}
            disabled={!!error || deleting}
          >
            {deleting ? 'Deleting...' : 'Delete Image'}
          </button>
        </div>
      </div>
    </div>
  );
}

function App(){
  const [mapper, setMapper] = useState({});
  const [loading, setLoading] = useState(true);
  const [editPath, setEditPath] = useState(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [renamePath, setRenamePath] = useState(null);
  const [deletePath, setDeletePath] = useState(null);
  const [showConfigFiles, setShowConfigFiles] = useState(null);
  const [editingConfig, setEditingConfig] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalTarget, setTerminalTarget] = useState(null); // { path, service }
  const [tab, setTab] = useState('projects');
  const [loggedIn, setLoggedIn] = useState(false);
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [view, setView] = useState('public'); // public or console
  const [stats, setStats] = useState({});
  const [statsRange, setStatsRange] = useState('1h');
  const [chart, setChart] = useState(null);
  const [publicMapper, setPublicMapper] = useState({});
  const [statsLabels, setStatsLabels] = useState([]);
  const availableImages = React.useMemo(() => {
    const set = new Set();
    try {
      Object.values(mapper || {}).forEach(item => {
        Object.values(item.services || {}).forEach(s => { if (s && s.image) set.add(String(s.image)); });
      });
    } catch(e) {}
    try {
      const remote = localStorage.getItem('remoteImages');
      if (remote) JSON.parse(remote).forEach(name => set.add(String(name)));
    } catch(e) {}
    return Array.from(set).sort((a,b)=> a.localeCompare(b));
  }, [mapper]);

  // Notifications globally disabled per user request: no-op
  function showNotification(message, type='info', timeout=4000){
    return; // intentionally do nothing
  }

  async function handleAttach(path) {
    try {
      const res = await axios.post('/api/attach', { path });
      if (res && res.data) {
        const data = res.data;
        if (data.error) {
          showNotification('Attach failed: '+data.error, 'error');
          return;
        }
        // show a helpful message with running services and suggested commands
        let msg = 'Running services: ' + (data.running && data.running.length ? data.running.join(', ') : 'none');
        if (data.commands && data.commands.length) {
          msg += '\nSuggested commands:\n' + data.commands.join('\n');
        }
        showNotification(msg, 'info', 12000);
        // Open a separate window with the terminal instead of in-page modal.
        if (data.running && data.running.length) {
          let service = null;
          if (data.running.length === 1) service = data.running[0];
          else {
            // simple prompt selection for now
            service = window.prompt('Select service to attach (one of: ' + data.running.join(', ') + ')', data.running[0]);
            if (service && !data.running.includes(service)) {
              showNotification('Invalid service chosen', 'error');
              return;
            }
          }
          if (service) {
            const url = '/terminal.html?' + new URLSearchParams({ file: path, service }).toString();
            const win = window.open(url, '_blank', 'noopener');
            if (!win) {
              // avoid showing a persistent UI notification for popup blockers
              // keep a console warning instead so developers can debug without alerting users
              console.warn('Popup blocked: unable to open terminal window for ' + path + ' service ' + service);
            }
          }
        } else {
          showNotification('No running services to attach.', 'error');
        }
      }
    } catch (e) {
      showNotification('Attach request failed: ' + ((e.response && e.response.data && e.response.data.error) || e.message), 'error');
    }
  }

  function closeTerminal() { setTerminalOpen(false); setTerminalTarget(null); }
  function removeNotification(id){ setNotifications(n=>n.filter(x=>x.id!==id)); }

  useEffect(() => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = token;
      setLoggedIn(true);
      fetchMapper();
      const interval = setInterval(pollMapper, 5000);
      return () => clearInterval(interval);
    } else {
      setLoggedIn(false);
    }
  }, [token]);

  useEffect(() => {
    if (view === 'public') {
      fetchPublicMapper();
      fetchStats();
      
      // Refresh data every 30 seconds for real-time status updates
      const interval = setInterval(() => {
        fetchPublicMapper();
        fetchStats();
      }, 30000);
      
      return () => clearInterval(interval);
    }
  }, [statsRange, view]);

  function fetchPublicMapper(){
    axios.get('/api/mapper').then(r=>{ setPublicMapper(r.data||{}); }).catch(e=>{ setPublicMapper({}); });
  }

  function fetchMapper(){
    setLoading(true);
    axios.get('/api/mapper').then(r=>{ setMapper(r.data||{}); setLoading(false);} ).catch(e=>{ setMapper({}); setLoading(false); showNotification('failed to load mapper','error'); });
  }

  function pollMapper(){
    axios.get('/api/mapper').then(r=>{ setMapper(r.data||{}); } ).catch(e=>{ showNotification('failed to update mapper','error'); });
  }

  function fetchStats(){
    axios.get('/api/stats', { params: { range: statsRange } }).then(r=>{ 
      setStats(r.data.services || {}); 
      setStatsLabels(r.data.labels || []);
    }).catch(e=>{ 
      setStats({}); 
      setStatsLabels([]);
    });
  }

  function login(password){
    axios.post('/api/login', { password }).then(r => {
      const t = r.data.token;
      setToken(t);
      localStorage.setItem('token', t);
      axios.defaults.headers.common['Authorization'] = t;
      setLoggedIn(true);
      setView('console');
    }).catch(e => {
      showNotification('Login failed', 'error');
    });
  }

  function logout(){
    setToken('');
    localStorage.removeItem('token');
    delete axios.defaults.headers.common['Authorization'];
    setLoggedIn(false);
    setView('public');
  }

  // Axios interceptor for handling 401
  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      response => response,
      error => {
        if (error.response && error.response.status === 401) {
          logout();
        }
        return Promise.reject(error);
      }
    );
    return () => {
      axios.interceptors.response.eject(interceptor);
    };
  }, []);

  useEffect(() => {
    if (view === 'public' && Object.keys(publicMapper).length > 0) {
      // Destroy existing charts first
      Object.entries(publicMapper).forEach(([path, item]) => {
        const folderName = path.split('/').pop();
        const ctx = document.getElementById(`chart-${folderName}`);
        if (ctx && ctx.chart) {
          ctx.chart.destroy();
          ctx.chart = null;
        }
      });

      // Create new charts
      Object.entries(publicMapper).forEach(([path, item]) => {
        const folderName = path.split('/').pop();
        const serviceData = stats[folderName] || [];
        const ctx = document.getElementById(`chart-${folderName}`);
        if (ctx && window.Chart && serviceData.length > 0) {
          const newChart = new window.Chart(ctx, {
            type: 'line',
            data: {
              labels: statsLabels,
              datasets: [{
                label: 'Requests',
                data: serviceData,
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderColor: 'rgba(75, 192, 192, 1)',
                borderWidth: 1,
                fill: true
              }]
            },
            options: {
              scales: {
                y: { beginAtZero: true, display: false },
                x: { display: false }
              },
              plugins: {
                legend: { display: false },
                tooltip: {
                  enabled: true,
                  mode: 'index',
                  intersect: false,
                  backgroundColor: 'rgba(0, 0, 0, 0.8)',
                  titleColor: '#fff',
                  bodyColor: '#fff',
                  borderColor: 'rgba(75, 192, 192, 1)',
                  borderWidth: 1,
                  cornerRadius: 4,
                  displayColors: false,
                  callbacks: {
                    title: function(context) {
                      return context[0].label;
                    },
                    label: function(context) {
                      return `Requests: ${context.parsed.y}`;
                    }
                  }
                }
              },
              elements: {
                point: { radius: 0 }
              },
              interaction: {
                mode: 'index',
                intersect: false
              }
            }
          });
          // Store reference to chart for cleanup
          ctx.chart = newChart;
        }
      });
    }

    // Cleanup function to destroy charts when view changes or component unmounts
    return () => {
      if (view === 'public') {
        Object.entries(publicMapper).forEach(([path, item]) => {
          const folderName = path.split('/').pop();
          const ctx = document.getElementById(`chart-${folderName}`);
          if (ctx && ctx.chart) {
            ctx.chart.destroy();
            ctx.chart = null;
          }
        });
      }
    };
  }, [stats, publicMapper, view, statsLabels]);

  // Cleanup charts on unmount
  useEffect(() => {
    return () => {
      // Destroy all charts when component unmounts
      Object.entries(publicMapper).forEach(([path, item]) => {
        const folderName = path.split('/').pop();
        const ctx = document.getElementById(`chart-${folderName}`);
        if (ctx && ctx.chart) {
          ctx.chart.destroy();
          ctx.chart = null;
        }
      });
    };
  }, []);

  if (view === 'public') {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Docker Request Stats</h1>
          <div className="flex gap-2">
            <select value={statsRange} onChange={e => setStatsRange(e.target.value)} className="border px-2 py-1">
              <option value="1h">1 Hour</option>
              <option value="6h">6 Hours</option>
              <option value="1day">1 Day</option>
              <option value="3day">3 Days</option>
              <option value="1week">1 Week</option>
              <option value="1month">1 Month</option>
            </select>
            <button className="bg-blue-600 text-white px-3 py-1 rounded" onClick={() => setView('console')}>Go to Console</button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Object.entries(publicMapper).map(([path, item]) => {
            const folderName = path.split('/').pop();
            const serviceData = stats[folderName] || [];
            const totalRequests = serviceData.reduce((sum, count) => sum + count, 0);
            return (
              <div key={path} className="bg-white shadow rounded p-4">
                <h3 className="font-semibold mb-2">{folderName}</h3>
                <p className="text-sm text-gray-600 mb-2">Total Requests: {totalRequests}</p>
                <div className="mb-2">
                  <div className="text-sm text-gray-700 mb-1">Services:</div>
                  {Object.entries(item.services || {}).map(([svcName, svcData]) => (
                    <div key={svcName} className="flex items-center gap-2 text-xs">
                      <span className={`inline-block w-2 h-2 rounded-full ${
                        (svcData && svcData.status === 'running') ? 'bg-green-500' :
                        (svcData && svcData.status === 'stopped') ? 'bg-red-500' :
                        (svcData && svcData.status === 'restarting') ? 'bg-yellow-500' :
                        (svcData && svcData.status === 'stopping') ? 'bg-orange-500' :
                        'bg-gray-400'
                      }`}></span>
                      <span>{svcName}:</span>
                      <span className={`font-medium ${
                        (svcData && svcData.status === 'running') ? 'text-green-600' :
                        (svcData && svcData.status === 'stopped') ? 'text-red-600' :
                        (svcData && svcData.status === 'restarting') ? 'text-yellow-600' :
                        (svcData && svcData.status === 'stopping') ? 'text-orange-600' :
                        'text-gray-600'
                      }`}>
                        {(svcData && svcData.status) || 'unknown'}
                      </span>
                    </div>
                  ))}
                </div>
                <canvas id={`chart-${folderName}`} width="200" height="100"></canvas>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div className="max-w-md mx-auto mt-20">
        <h1 className="text-2xl font-bold mb-4">Login to Console</h1>
        <input type="password" placeholder="Password" id="password" className="border px-2 py-1 w-full mb-4" />
        <button className="bg-blue-600 text-white px-3 py-1 rounded w-full" onClick={() => login(document.getElementById('password').value)}>Login</button>
        <button className="bg-gray-600 text-white px-3 py-1 rounded w-full mt-2" onClick={() => setView('public')}>Back to Public</button>
      </div>
    );
  }

  function openEditor(path){ setEditPath(path); }
  function closeEditor(){ setEditPath(null); }

  function openAddModal(){ setAddModalOpen(true); }
  function closeAddModal(){ setAddModalOpen(false); }

  function applyLocal(newData){
  return axios.post('/api/apply', { path: editPath, services: newData.services }).then(r=>{ showNotification('applied','info'); return r; }).catch(e=>{ showNotification('apply failed: '+(e && e.message ? e.message : String(e)),'error'); throw e; });
  }

  async function addProject(name) {
    try {
      await axios.post('/api/add', { name });
      showNotification('Project added successfully', 'info');
      fetchMapper(); // refresh the list
    } catch (e) {
      showNotification('Failed to add project: ' + ((e.response && e.response.data && e.response.data.error) || e.message), 'error');
    }
  }

  function openRenameModal(path){ setRenamePath(path); }
  function closeRenameModal(){ setRenamePath(null); }

  function openDeleteModal(path){ setDeletePath(path); }
  function closeDeleteModal(){ setDeletePath(null); }

  async function renameProject(oldPath, newName) {
    try {
      await axios.post('/api/rename', { oldPath, newName });
      showNotification('Project renamed successfully', 'info');
      fetchMapper(); // refresh the list
    } catch (e) {
      showNotification('Failed to rename project: ' + ((e.response && e.response.data && e.response.data.error) || e.message), 'error');
    }
  }

  async function deleteProject(path, confirmName) {
    try {
      await axios.post('/api/delete', { path, confirmName });
      showNotification('Project deleted successfully', 'info');
      fetchMapper(); // refresh the list
    } catch (e) {
      showNotification('Failed to delete project: ' + ((e.response && e.response.data && e.response.data.error) || e.message), 'error');
    }
  }

  function openConfigFiles(projectPath, hostPath){ 
    // If called with both projectPath and hostPath, prefer opening editor directly.
    // If hostPath is a relative path (doesn't start with '/'), treat it as relative to projectPath.
    try {
      if (typeof hostPath !== 'undefined'){
        const host = String(hostPath || '');
        const proj = String(projectPath || '');
        const isRelative = host !== '' && !host.startsWith('/');
        if (isRelative) {
          // strip leading ./ if present and optional leading 'config/' then take basename
          let filename = host.replace(/^\.\//, '');
          filename = filename.replace(/^config\//, '');
          filename = filename.split('/').pop();
          setEditingConfig({ path: proj, filename });
          setShowConfigFiles(null);
          return;
        }
        // if host is absolute, try to map it back into the project's config directory
        if (host && host.startsWith('/')){
          const projBase = proj.split('/').pop();
          const marker = '/apps/' + projBase + '/config/';
          const idx = host.indexOf(marker);
          if (idx !== -1){
            let filename = host.slice(idx + marker.length);
            filename = filename.split('/').pop();
            setEditingConfig({ path: proj, filename });
            setShowConfigFiles(null);
            return;
          }
          // otherwise fallthrough to showing project-level modal (cannot safely open arbitrary absolute host path)
        }
      }
    } catch (e) { /* ignore and fallback */ }
    // fallback: show project-level config files modal
    setShowConfigFiles(projectPath);
  }
  function closeConfigFiles(){ setShowConfigFiles(null); }

  function closeConfigEditor(){ setEditingConfig(null); }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Docker Mapper Console</h1>
        <div>
          <button className="bg-gray-600 text-white px-3 py-1 rounded mr-2" onClick={logout}>Logout</button>
          <button className="bg-gray-600 text-white px-3 py-1 rounded" onClick={() => setView('public')}>Public View</button>
        </div>
      </div>

  <div className="mb-4">
  <button className="px-3 py-1 mr-2" onClick={()=>setTab('networks')}>Networks</button>
  <button className="px-3 py-1 mr-2" onClick={()=>setTab('projects')}>Projects</button>
  <button className="px-3 py-1 mr-2" onClick={()=>setTab('images')}>Images</button>
  <button className="px-3 py-1" onClick={()=>setTab('nginx')}>Nginx</button>
  </div>

  {tab === 'projects' && (loading ? <div>Loading...</div> : <ProjectList mapper={mapper} onEdit={openEditor} onAdd={openAddModal} onRename={openRenameModal} onDelete={openDeleteModal} onAttach={handleAttach} />)}

  {tab === 'networks' && (loading ? <div>Loading...</div> : <NetworkList showNotification={showNotification} />)}
  {tab === 'images' && (loading ? <div>Loading...</div> : <ImageList mapper={mapper} showNotification={showNotification} onOpenProject={openEditor} />)}

  {editPath && <EditorModal path={editPath} data={mapper[editPath]} onClose={closeEditor} onApply={applyLocal} onEditConfig={openConfigFiles} showNotification={showNotification} availableImages={availableImages} />}

  {addModalOpen && <AddProjectModal onClose={closeAddModal} onAdd={addProject} mapper={mapper} />}

  {renamePath && <RenameProjectModal path={renamePath} onClose={closeRenameModal} onRename={renameProject} mapper={mapper} />}

  {deletePath && <DeleteProjectModal path={deletePath} onClose={closeDeleteModal} onDelete={deleteProject} />}

  {showConfigFiles && (
    <ConfigFilesModal 
      path={showConfigFiles} 
      onClose={closeConfigFiles} 
  onEditConfig={openConfigFiles}
      showNotification={showNotification}
    />
  )}

  {editingConfig && (
    <ConfigEditorModal 
      path={editingConfig.path} 
      filename={editingConfig.filename} 
      onClose={closeConfigEditor}
      onSave={() => {}} // Not needed since save is handled internally
      showNotification={showNotification}
    />
  )}

  {tab === 'nginx' && <NginxEditor mapper={mapper} showNotification={showNotification} />}

  <NotificationContainer notifications={notifications} onRemove={removeNotification} />
    </div>
  );
}

function TerminalModal({open, target, onClose}){
  const termRef = React.useRef(null);
  const wsRef = React.useRef(null);
  useEffect(()=>{
    if (!open || !target) return;
    // lazy load xterm and fit addon from global (unpkg bundled in page)
  const Terminal = (window && (window.Terminal || window.XTerm)) || null;
  const FitAddon = (window && (window.FitAddon || (window.XTerm && window.XTerm.FitAddon))) || null;
  const term = Terminal ? new Terminal({cols:80, rows:24}) : new window.Terminal({cols:80, rows:24});
    termRef.current = term;
    const el = document.getElementById('terminal-root');
    term.open(el);
    let fit = null;
    if (FitAddon) {
      try { fit = new FitAddon(); term.loadAddon(fit); fit.fit(); } catch(e){}
    }
    // connect websocket
    const params = new URLSearchParams({ file: target.path, service: target.service });
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/ws/attach?${params.toString()}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { term.write('\x1b[32mConnected to container\x1b[0m\r\n'); };
    ws.onmessage = (ev) => { const data = ev.data; if (typeof data === 'string') term.write(data); else term.write(new TextDecoder().decode(data)); };
    ws.onclose = () => { 
      term.write('\r\n\x1b[31mConnection closed\x1b[0m'); 
      try {
        // display a short countdown in the terminal area by writing status line
        let seconds = 5;
        term.write('\r\nConnection closed — closing in ' + seconds + 's');
        const countdown = setInterval(() => {
          seconds -= 1;
          try { term.write('\r\nClosing in ' + seconds + 's'); } catch(e){}
          if (seconds <= 0) clearInterval(countdown);
        }, 1000);
        setTimeout(() => { try { window.close(); } catch(e){} }, 5000);
      } catch(e){}
    };
    term.onData(d => { try { ws.send(d); } catch (e) {} });

    // send initial resize after opening
    function sendResize(){
      try {
        const dims = { cols: term.cols || 80, rows: term.rows || 24 };
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      } catch(e){}
    }
    sendResize();

    // observe resize of container and call fit + notify backend
    let resizeObserver = null;
    try {
      resizeObserver = new ResizeObserver(()=>{
        if (fit) { try { fit.fit(); } catch(e){} }
        sendResize();
      });
      resizeObserver.observe(el);
      // also send on window resize
      window.addEventListener('resize', sendResize);
    } catch(e){}
    return () => {
      try { if (resizeObserver) resizeObserver.disconnect(); } catch(e){}
      try { window.removeEventListener('resize', sendResize); } catch(e){}
      try { ws.close(); } catch(e){}
      try { term.dispose(); } catch(e){}
    };
  }, [open, target]);

  if (!open) return null;
  const modal = (
    <div className="fixed inset-0 bg-black/80 flex items-stretch justify-stretch z-50">
      <div className="bg-black w-full h-full flex flex-col">
        <div className="flex justify-between items-center p-2 border-b border-gray-800 text-white">
          <div className="font-semibold">Service: {target && target.service}</div>
          <div className="flex gap-2">
            <button className="px-3 py-1 bg-gray-800 text-white rounded" onClick={onClose}>Close</button>
          </div>
        </div>
        <div id="terminal-root" className="flex-1 w-full" style={{overflow:'hidden', height: 'calc(100vh - 48px)'}} />
      </div>
    </div>
  );
  return ReactDOM.createPortal(modal, document.body);
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);

function NginxEditor({mapper, showNotification}){
  const [content, setContent] = useState('');
  const [upstreams, setUpstreams] = useState([]);
  const [upstreamErrors, setUpstreamErrors] = useState({});
  const [servers, setServers] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(()=>{ load(); }, []);

  // regenerate preview whenever upstreams or servers change
  useEffect(()=>{ setContent(generateConfig()); }, [upstreams, servers]);

    // build mapper entries and ip->key map
    // Only include services that have a discoverable/static IP so they appear in selects
    const mapperEntries = [];
    const ipToKey = {};
    Object.entries(mapper||{}).forEach(([p,info])=>{
      Object.entries(info.services||{}).forEach(([svc,s])=>{
        const key = `${p}:::${svc}`;
        let ip = '';
        if (s && s.networks) {
          const nets = Object.values(s.networks||{});
          if (nets.length>0) {
            const first = nets[0];
            if (typeof first === 'string') ip = first;
            else if (first && typeof first === 'object') ip = first.ipv4_address || first.ipv4Address || '';
          }
        }
  // show only the project folder name (last path segment) instead of full path
  const folder = String(p||'').split('/').filter(Boolean).pop() || p;
  const label = folder + ' :: ' + svc;
        // only add entries that have an IP; services without static IP should not be selectable
        if (ip) {
          mapperEntries.push({ key, label, ip });
          ipToKey[ip] = key;
        }
      });
    });

  async function load(){
    try {
      const r = await axios.get('/api/nginx');
      setContent(r.data.content||'');
        // if server provided parsed data, populate form fields and prefer mapper selections when IP matches
        if (r.data && r.data.parsed) {
          const parsed = r.data.parsed;
          const ups = (parsed.upstreams || []).map(u => {
            const svr = (u.servers && u.servers[0]) || '';
            const parts = String(svr).split(':');
            const address = parts[0] || '';
            const port = parts[1] || '80';
            if (address && ipToKey[address]) {
              return { name: u.name || '', source: 'mapper', address, port, mapperKey: ipToKey[address] };
            }
            return { name: u.name || '', source: 'manual', address, port };
          });
          setUpstreams(ups);

          // build helper: list of upstream names for matching
          const upNames = ups.map(x=>x.name).filter(Boolean);

          const svs = (parsed.servers || []).map(s => {
            const listen = s.listen || '';
            // listen may be like "443 ssl" or "127.0.0.1:443 ssl" - extract port and ssl flag
            let port = '80';
            try {
              const parts = String(listen).split(/\s+/).filter(Boolean);
              // first part may contain host:port or just port
              const first = parts[0] || '';
              if (first.indexOf(':') !== -1) port = String(first).split(':').pop();
              else if (/^\d+$/.test(first)) port = first;
              // detect explicit ssl keyword
              var detectedSsl = parts.slice(1).some(p => String(p).toLowerCase() === 'ssl');
            } catch (e) { port = '80'; }
            const locs = (s.locations || []).map(l => {
              const proxy = l.proxy_pass || '';
              // try to detect upstream name inside proxy_pass (e.g. http://template_core/)
              let matched = '';
              try {
                const cleaned = proxy.replace(/^\s*https?:\/\//i,'').replace(/\/.*$/,'').replace(/:\d+$/,'');
                for (const name of upNames) {
                  if (name && (cleaned === name || cleaned.endsWith('.' + name) || proxy.indexOf(name) !== -1)) { matched = name; break; }
                }
              } catch(e){}
              // if parser provided a redirect field, prefer that
              if (l.redirect) return { location: l.location || '/', upstream: '', type: 'redirect', redirect: l.redirect, useUri: false, raw: l.raw || '' };
              return { location: l.location || '/', upstream: matched || '', type: 'proxy', useUri: (proxy||'').endsWith('/'), raw: l.raw || '' };
            });
            // also treat presence of ssl_certificate or ssl_certificate_key as enabling ssl
            const hasCert = !!(s.ssl_certificate || s.ssl_certificate_key);
            return { servername: s.server_name || '', port, ssl: (!!s.ssl) || detectedSsl || hasCert, sslcert: s.ssl_certificate || '', sslkey: s.ssl_certificate_key || '', locations: locs.length?locs:[{ location: '/', upstream: '', useUri: true, raw: '', showRaw: false }] };
          });
          setServers(svs);
        }
    } catch (e) { showNotification('failed to load nginx config','error'); }
  }

    function escape(s){ return String(s||''); }

    function generateConfig(){
      const lines = [
        "# Generated by Console GUI",
        "",
        "log_format comm '$remote_addr - $remote_user [$time_local] \"$request\" '",
        "  '$status $body_bytes_sent \"$http_referer\" \"$http_user_agent\" \"$upstream_addr\"';",
        "",
      ];
      // upstreams
      for (const u of upstreams) {
        const name = escape(u.name || '');
        if (!name) continue;
        lines.push(`upstream ${name} {`);
        if (u.source === 'mapper') {
          // try to find mapper entry by address
          const me = mapperEntries.find(m=>m.ip && (m.ip === u.address || m.ip.indexOf(u.address) !== -1));
          if (me) lines.push(`  server ${me.ip}:${u.port};`);
          else lines.push(`  server ${escape(u.address)}:${escape(u.port)};`);
        } else {
          lines.push(`  server ${escape(u.address)}:${escape(u.port)};`);
        }
        lines.push('}', '');
      }
      // servers
      for (const s of servers) {
        lines.push('server {');
        // server_name should appear first inside the server block
        if (s.servername) lines.push(`  server_name ${escape(s.servername)};`);

        // then the locations
        for (const loc of s.locations || []){
          const upstream = loc.upstream || '';
          const slash = loc.useUri ? '/' : '';
          lines.push(`  location ${escape(loc.location)} {`);
          // redirect takes precedence when provided
          if (loc.redirect && String(loc.redirect).trim()) {
            lines.push(`    return 301 ${escape(loc.redirect)};`);
          } else if (upstream) {
            lines.push(`    proxy_pass http://${escape(upstream)}${slash};`);
            // WebSocket support (safe for normal HTTP too)
            lines.push(`    proxy_http_version 1.1;`);
            lines.push(`    proxy_set_header Upgrade $http_upgrade;`);
            lines.push(`    proxy_set_header Connection "upgrade";`);
            lines.push(`    proxy_set_header Host $host;`);
            // Longer timeouts to keep interactive sessions open
            lines.push(`    proxy_read_timeout 3600;`);
            lines.push(`    proxy_send_timeout 3600;`);
            lines.push(`    proxy_connect_timeout 60;`);
          }
          lines.push(`    access_log /var/log/nginx/comm.log comm;`);
          lines.push('  }');
        }

        // ssl directives (certificate/key) should come after locations
        if (s.ssl && s.sslcert) lines.push(`  ssl_certificate ${escape(s.sslcert)};`);
        if (s.ssl && s.sslkey) lines.push(`  ssl_certificate_key ${escape(s.sslkey)};`);

        // finally the listen directive (include ssl flag if applicable)
        if (s.ssl) {
          lines.push(`  listen ${escape(s.port)} ssl;`);
        } else {
          lines.push(`  listen ${escape(s.port)};`);
        }

        lines.push('}', '');
      }
      return lines.join('\n');
    }

  function addUpstream(){ setUpstreams(u=>[...u, { name: '', source: 'manual', address: '', port: '80' }]); }
  function removeUpstream(i){ setUpstreams(u=>u.filter((_,k)=>k!==i)); }

  function addServer(){ setServers(s=>[...s, { servername: '', port: 80, ssl: false, sslcert:'', sslkey:'', locations: [] }]); }
  function removeServer(i){ setServers(s=>s.filter((_,k)=>k!==i)); }

  async function save(){
    setSaving(true);
    try {
      await axios.post('/api/nginx/save', { content });
      showNotification('nginx config saved','info');
    } catch (e) { showNotification('save failed','error'); }
    setSaving(false);
  }

  // mapper options for upstream selection
  const mapperOptions = Object.entries(mapper).flatMap(([path,info])=>{
  const folder = String(path||'').split('/').filter(Boolean).pop() || path;
  return Object.entries(info.services||{}).map(([svc,s])=>({ label: folder + ' :: ' + svc, value: s }));
  });

  return (
    <div>
      <h2 className="text-lg font-semibold mb-2">Nginx Editor</h2>
      <div className="mb-3">
        <div className="font-medium">Upstreams</div>
        {upstreams.map((u,i)=> (
          <div key={i} className="flex gap-2 items-center my-2">
            <div className="flex flex-col">
              <input placeholder="name" value={u.name} onChange={e=>{ const val = e.target.value; const next=[...upstreams]; next[i].name=val; setUpstreams(next); const lc = String(val||'').toLowerCase(); if (lc === 'redirect' || lc === 'upstream') { setUpstreamErrors(err=>({ ...err, [i]: 'Reserved name' })); } else { setUpstreamErrors(err=>{ const copy = { ...err }; delete copy[i]; return copy; }); } }} className={`border px-2 py-1 ${upstreamErrors[i] ? 'border-red-600' : ''}`} />
              {upstreamErrors[i] && <div className="text-xs text-red-600 mt-1">{upstreamErrors[i]}</div>}
            </div>
            <select value={u.source} onChange={e=>{ const next=[...upstreams]; next[i].source=e.target.value; setUpstreams(next); }} className="border px-2 py-1">
              <option value="manual">manual</option>
              <option value="mapper">mapper</option>
            </select>
            {u.source === 'manual' ? (
              <input placeholder="address" value={u.address} onChange={e=>{ const next=[...upstreams]; const val=e.target.value; next[i].address=val; // detect mapper by ip
                const ip = String(val||'').split(':')[0]; if (ip && ipToKey[ip]) { next[i].source='mapper'; next[i].mapperKey = ipToKey[ip]; }
                setUpstreams(next); }} className="border px-2 py-1" />
            ) : (
              <select value={u.mapperKey||''} onChange={e=>{ const val=e.target.value; const next=[...upstreams]; next[i].mapperKey=val; // set address from mapper entry if known
                const found = mapperEntries.find(x=>x.key===val); if (found) next[i].address = found.ip || next[i].address; setUpstreams(next); }} className="border px-2 py-1">
                <option value="">select service</option>
                {mapperEntries.map((opt,idx)=>(<option key={idx} value={opt.key}>{opt.label}{opt.ip?` (${opt.ip})`:''}</option>))}
              </select>
            )}
            <input placeholder="port" value={u.port} onChange={e=>{ const next=[...upstreams]; next[i].port=e.target.value; setUpstreams(next); }} className="border px-2 py-1 w-20" />
            <button className="text-red-600" onClick={()=>removeUpstream(i)}>delete</button>
          </div>
        ))}
        <div><button className="px-2 py-1 bg-green-600 text-white" onClick={addUpstream}>Add</button></div>
      </div>

      <div className="mb-3">
        <div className="font-medium">Servers</div>
        {servers.map((s,i)=> (
          <div key={i} className="border p-2 my-2">
            <div className="flex gap-2 items-center">
              <input placeholder="servername" value={s.servername} onChange={e=>{ const next=[...servers]; next[i].servername=e.target.value; setServers(next); }} className="border px-2 py-1" />
              <input placeholder="port" value={s.port} onChange={e=>{ const next=[...servers]; next[i].port=e.target.value; setServers(next); }} className="border px-2 py-1 w-20" />
              <label><input type="checkbox" checked={s.ssl} onChange={e=>{ const next=[...servers]; next[i].ssl=e.target.checked; setServers(next); }} /> SSL</label>
              {s.ssl && (
                <div className="flex gap-2">
                  <input placeholder="ssl cert" value={s.sslcert} onChange={e=>{ const next=[...servers]; next[i].sslcert=e.target.value; setServers(next); }} className="border px-2 py-1" />
                  <input placeholder="ssl key" value={s.sslkey} onChange={e=>{ const next=[...servers]; next[i].sslkey=e.target.value; setServers(next); }} className="border px-2 py-1" />
                </div>
              )}
            </div>
            <div className="mt-2">
              {s.locations.map((loc,li)=> (
                <div key={li} className="mt-2">
                  <div className="flex gap-2 items-center">
                    <input placeholder="location" value={loc.location} onChange={e=>{ const next=[...servers]; next[i].locations[li].location=e.target.value; setServers(next); }} className="border px-2 py-1" />
                    <select value={loc.upstream || (loc.type === 'redirect' ? 'redirect' : '')} onChange={e=>{ const next=[...servers]; const val=e.target.value; // if user selects 'redirect', clear upstream and set type
                      if (val === 'redirect') {
                        next[i].locations[li].upstream = '';
                        next[i].locations[li].type = 'redirect';
                        next[i].locations[li].redirect = next[i].locations[li].redirect || '';
                      } else {
                        // selecting an upstream should clear any previous redirect value
                        next[i].locations[li].upstream = val;
                        next[i].locations[li].type = 'proxy';
                        next[i].locations[li].redirect = '';
                        // ensure useUri has a sensible default when switching to proxy
                        if (typeof next[i].locations[li].useUri === 'undefined') next[i].locations[li].useUri = true;
                      }
                      setServers(next);
                    }} className="border px-2 py-1">
                      <option value="">upstream</option>
                      <option value="redirect">redirect</option>
                      {upstreams.map((u,ui)=>(<option key={ui} value={u.name||''}>{u.name||u.address||'(unnamed)'}</option>))}
                    </select>
                    {loc.type === 'redirect' ? (
                      <input placeholder="redirect url (e.g. https://example.com)" value={loc.redirect||''} onChange={e=>{ const next=[...servers]; next[i].locations[li].redirect = e.target.value; setServers(next); }} className="border px-2 py-1 flex-1" />
                    ) : null}
                    {loc.type !== 'redirect' ? (
                      <label className="flex items-center gap-1"><input type="checkbox" checked={loc.useUri!==false} onChange={e=>{ const next=[...servers]; next[i].locations[li].useUri = e.target.checked; setServers(next); }} /> Slash</label>
                    ) : null}
                    <button className="text-red-600" onClick={()=>{ const next=[...servers]; next[i].locations = next[i].locations.filter((_,k)=>k!==li); setServers(next); }}>delete</button>
                  </div>
                </div>
              ))}
              <div className="mt-2"><button className="px-2 py-1 bg-green-600 text-white" onClick={()=>{ const next=[...servers]; next[i].locations.push({ location:'/', upstream:'', type: 'proxy', useUri: true, redirect: '' }); setServers(next); }}>Add location</button></div>
            </div>
            <div className="mt-2"><button className="text-red-600" onClick={()=>removeServer(i)}>delete server</button></div>
          </div>
        ))}
        <div><button className="px-2 py-1 bg-green-600 text-white" onClick={addServer}>Add server</button></div>
      </div>

      <div className="mb-3">
        <div className="font-medium">Raw config preview</div>
        <textarea rows={10} value={content} readOnly={true} className="w-full border p-2 bg-gray-100" />
  <div className="mt-2"><button className={`px-3 py-1 ${saving ? 'bg-gray-400 cursor-not-allowed' : 'bg-yellow-600 text-white'}`} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button></div>
      </div>
    </div>
  );
}

function NetworkList({ showNotification }){
  const [networks, setNetworks] = useState([]);
  const [loadingN, setLoadingN] = useState(true);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [editingNetwork, setEditingNetwork] = useState(null);
  const [deletingNetwork, setDeletingNetwork] = useState(null);

  useEffect(()=>{ load(); }, []);

  async function load(){
    try {
      setLoadingN(true);
      const r = await axios.get('/api/networks');
      setNetworks(r.data.networks || []);
    } catch (e) {
      showNotification && showNotification('Failed to load networks: '+((e.response && e.response.data && e.response.data.error) || e.message),'error');
    } finally { setLoadingN(false); }
  }

  async function createNetwork(){
    if (!newName.trim()) return;
    try {
      setCreating(true);
      await axios.post('/api/networks/create', { name: newName.trim() });
      showNotification && showNotification('Network created','info');
      setNewName('');
      load();
    } catch (e) {
      showNotification && showNotification('Create failed: '+((e.response && e.response.data && e.response.data.error) || e.message),'error');
    } finally { setCreating(false); }
  }

  async function deleteNetwork(name){
    if (!name) return;
    try {
      setDeleting(name);
      await axios.post('/api/networks/delete', { name });
      showNotification && showNotification('Network deleted','info');
      load();
    } catch (e) {
      showNotification && showNotification('Delete failed: '+((e.response && e.response.data && e.response.data.error) || e.message),'error');
    } finally { setDeleting(null); }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Networks</h2>
        <div className="flex items-center gap-2">
          <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="network name (e.g. my-net)" className="border px-2 py-1 rounded" />
          <button className={`px-3 py-1 rounded ${newName.trim() ? 'bg-green-600 text-white' : 'bg-gray-300'}`} onClick={createNetwork} disabled={!newName.trim() || creating}>{creating ? 'Creating...' : 'Create'}</button>
        </div>
      </div>
      {loadingN ? <div>Loading networks...</div> : (
        networks.length === 0 ? <div className="text-gray-500">No networks found</div> : (
          <div className="space-y-2">
            {networks.map(n => (
              <div key={n.Name} className="bg-white shadow rounded p-4 flex justify-between items-center">
                <div>
                  <div className="font-medium">{n.Name} <span className="text-xs text-gray-500">{n.Driver || ''}</span></div>
                  <div className="text-xs text-gray-500">Scope: {n.Scope || 'local'}</div>
                  <div className="text-xs text-gray-500">Subnet: {(n.IPAM && n.IPAM.Config && n.IPAM.Config[0] && n.IPAM.Config[0].Subnet) || 'N/A'}</div>
                </div>
                <div className="flex gap-2">
                  <button className={`px-3 py-1 rounded ${['bridge','host','none'].includes(n.Name) ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white'}`} onClick={()=>setEditingNetwork(n)} disabled={['bridge','host','none'].includes(n.Name)}>Edit</button>
                  <button className={`px-3 py-1 rounded ${deleting===n.Name? 'bg-gray-400' : (['bridge','host','none'].includes(n.Name) ? 'bg-gray-400 cursor-not-allowed' : 'bg-red-600 text-white')}`} onClick={()=>setDeletingNetwork(n)} disabled={deleting===n.Name || ['bridge','host','none'].includes(n.Name)}>{deleting===n.Name? 'Deleting...' : 'Delete'}</button>
                </div>
              </div>
            ))}
          </div>
        )
      )}
      {editingNetwork && <NetworkEditModal network={editingNetwork} onClose={()=>setEditingNetwork(null)} onSave={load} showNotification={showNotification} />}
      {deletingNetwork && <DeleteNetworkModal network={deletingNetwork} onClose={()=>setDeletingNetwork(null)} onDelete={deleteNetwork} />}
    </div>
  );
}

function ImageDetailsModal({imageName, usage, onClose, onDelete, showNotification, services = [], onOpenProject}){
  const [pulling, setPulling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  if (!imageName) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold">Image: {imageName}</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="mb-4">
          <div className="text-sm text-gray-700 mb-2">Usage</div>
          <div className="text-sm text-gray-600">Online services: <strong>{usage.online}</strong></div>
          <div className="text-sm text-gray-600">Offline services: <strong>{usage.offline}</strong></div>
          <div className="mt-3 text-xs text-gray-500">Use the global "Pull new image" control above to pull an image that is not currently listed. Delete will remove the image locally (backend must handle safety checks).</div>
        </div>
        <div className="mb-3">
          {/* Group services by status then by project */}
          {(() => {
            if (!services || services.length===0) return <div className="text-sm text-gray-500">No services use this image.</div>;
            const byStatus = { online: [], offline: [], unknown: [] };
            services.forEach(s => {
              const st = (s.status === 'running') ? 'online' : (s.status === 'stopped' ? 'offline' : 'unknown');
              byStatus[st].push(s);
            });
            return ['online','offline','unknown'].map(statusKey => {
              const list = byStatus[statusKey];
              if (!list || list.length===0) return null;
              // group by projectName
              const byProject = {};
              list.forEach(it => { if (!byProject[it.projectName]) byProject[it.projectName] = []; byProject[it.projectName].push(it); });
              return (
                <div key={statusKey} className="mb-2">
                  <div className="font-medium capitalize">{statusKey} ({list.length})</div>
                  <div className="mt-1">
                    {Object.entries(byProject).map(([proj, items])=> (
                      <div key={proj} className="border rounded p-2 mt-2">
                        <div className="text-sm font-semibold">{proj}</div>
                        <div className="mt-1 text-sm">
                          {items.map(it=> (
                            <div key={it.projectPath + '::' + it.service} className="flex justify-between items-center py-1">
                              <div>
                                <a href="#" onClick={(e)=>{ e.preventDefault(); try{ onOpenProject && onOpenProject(it.projectPath); } catch(e){}; onClose(); }} className="text-blue-600 hover:underline">{it.service}</a>
                              </div>
                              <div className="text-xs text-gray-500">{it.status}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            });
          })()}
        </div>
        <div className="flex gap-2 justify-end">
          <button className={`px-3 py-1 rounded ${deleting ? 'bg-gray-400' : 'bg-red-600 text-white'}`} onClick={()=>{setShowDeleteModal(true);}} disabled={deleting}>{deleting ? 'Deleting...' : 'Delete'}</button>
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Close</button>
        </div>
        {showDeleteModal && (
          <DeleteImageModal
            imageName={imageName}
            onClose={()=>{setShowDeleteModal(false);}}
            onDelete={async (img) => {
              try {
                const result = await onDelete(img);
                showNotification && showNotification('Delete requested for '+img,'info');
                return result;
              } catch(e){
                showNotification && showNotification('Delete failed: '+String(e),'error');
                throw e;
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function ImageList({ mapper, showNotification, onOpenProject }){
  const [images, setImages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [newImage, setNewImage] = useState('');
  const [pulling, setPulling] = useState(false);
  const [remoteImages, setRemoteImages] = useState(() => {
    try { const v = localStorage.getItem('remoteImages'); return v ? JSON.parse(v) : []; } catch(e){ return []; }
  });
  const [allImages, setAllImages] = useState([]);

  useEffect(()=>{ buildImages(); }, [mapper]);
  useEffect(()=>{ fetchAllImages(); }, []);

  function fetchAllImages(){
    axios.get('/api/images/list').then(r => {
      setAllImages(r.data.images || []);
    }).catch(e => {
      console.error('Failed to fetch all images:', e);
      setAllImages([]);
    });
  }

  function buildImages(){
    // map image -> { online: count, offline: count, services: [{project, service, status}] }
    const map = {};
    Object.entries(mapper||{}).forEach(([path, item])=>{
      const projectName = path.split('/').pop();
      const projectPath = path;
      Object.entries(item.services||{}).forEach(([svc, sdata])=>{
        const img = (sdata && sdata.image) ? sdata.image : '(none)';
        if (!map[img]) map[img] = { online:0, offline:0, services: [] };
        const status = (sdata && sdata.status) || 'unknown';
        if (status === 'running') map[img].online += 1; else map[img].offline += 1;
        map[img].services.push({ projectName, projectPath, service: svc, status });
      });
    });
    const arr = Object.entries(map).map(([name, data])=> ({ name, ...data }));
    setImages(arr.sort((a,b)=> b.online + b.offline - (a.online + a.offline)));
  }

  async function handlePull(image){
    try { 
      await axios.post('/api/images/pull', { image });
      // Refresh the all images list
      fetchAllImages();
    } catch(e){ throw e; }
  }

  async function handleDelete(image){
    try { 
      const response = await axios.post('/api/images/delete', { image });
      // Refresh the all images list
      fetchAllImages();
      return response.data;
    } catch(e){ throw e; }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Images</h2>
        <div className="flex items-center gap-2">
          <input value={newImage} onChange={e=>setNewImage(e.target.value)} placeholder="image (e.g. nginx:latest)" className="border px-2 py-1 rounded" />
          <button className={`px-3 py-1 rounded ${pulling ? 'bg-gray-400' : 'bg-blue-600 text-white'}`} onClick={async ()=>{
            const img = String(newImage || '').trim();
            if (!img) return;
            // check not already present locally or in remote list
            if (images.some(i => i.name === img) || remoteImages.includes(img)) { showNotification && showNotification('Image already exists in list','error'); return; }
            try {
              setPulling(true);
              await handlePull(img);
              // add to remote images list and persist
              setRemoteImages(r => {
                try {
                  const next = Array.isArray(r) ? r.slice() : [];
                  if (!next.includes(img)) next.push(img);
                  localStorage.setItem('remoteImages', JSON.stringify(next));
                  return next;
                } catch(e){ return r; }
              });
              showNotification && showNotification('Pull requested for '+img,'info');
              setNewImage('');
            } catch(e){ showNotification && showNotification('Pull failed: '+String(e),'error'); } finally { setPulling(false); }
          }} disabled={pulling}>{pulling ? 'Pulling...' : 'Pull new image'}</button>
        </div>
      </div>
      {images.length===0 && <div className="text-gray-500">No images found</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-2">Local Images</h3>
          {images.length===0 ? <div className="text-gray-500">No local images found</div> : (
            <div className="space-y-2">
              {images.map(img => (
                <div key={img.name} className="bg-white shadow rounded p-4 cursor-pointer" onClick={()=>setSelected({ ...img, _source: 'local' })}>
                  <div className="font-medium truncate">{img.name}</div>
                  <div className="text-xs text-gray-500 mt-1">Total services: {img.online + img.offline}</div>
                  <div className="mt-2 flex gap-2">
                    <div className="text-xs px-2 py-1 rounded bg-green-100 text-green-800">Online: {img.online}</div>
                    <div className="text-xs px-2 py-1 rounded bg-red-100 text-red-800">Offline: {img.offline}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Remote Images (pulled)</h3>
          {remoteImages.length===0 ? <div className="text-gray-500">No remote images pulled</div> : (
            <div className="space-y-2">
              {remoteImages.map(name => (
                <div key={name} className="bg-white shadow rounded p-4 cursor-pointer" onClick={()=>setSelected({ name, online:0, offline:0, services: [], _source: 'remote' })}>
                  <div className="font-medium truncate">{name}</div>
                  <div className="text-xs text-gray-500 mt-1">Source: registry</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">All Docker Images</h3>
          {allImages.length===0 ? <div className="text-gray-500">No Docker images found</div> : (
            <div className="space-y-2">
              {allImages.map(img => (
                <div key={`${img.Repository}:${img.Tag}`} className="bg-white shadow rounded p-4 cursor-pointer" onClick={()=>setSelected({ name: `${img.Repository}:${img.Tag}`, online:0, offline:0, services: [], _source: 'docker' })}>
                  <div className="font-medium truncate">{img.Repository}:{img.Tag}</div>
                  <div className="text-xs text-gray-500 mt-1">Size: {img.Size}</div>
                  <div className="text-xs text-gray-500">Created: {new Date(img.CreatedAt).toLocaleDateString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <ImageDetailsModal
          imageName={selected.name}
          usage={{ online: selected.online || 0, offline: selected.offline || 0 }}
          onClose={()=>{ setSelected(null); }}
          onDelete={async (img)=>{
            try { await handleDelete(img); // remove from remote list if present
              setRemoteImages(r => { const next = r.filter(x => x !== img); try { localStorage.setItem('remoteImages', JSON.stringify(next)); } catch(e){} return next; });
            } catch(e) { throw e; }
          }}
          services={selected.services || []}
          onOpenProject={onOpenProject}
          showNotification={showNotification}
        />
      )}
    </div>
  );
}

function NetworkEditModal({ network, onClose, onSave, showNotification }){
  const [subnet, setSubnet] = useState('');
  const [gateway, setGateway] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(()=>{
    if (!network) return;
    // prefill from IPAM.Config[0] if available
    const cfg = (network.IPAM && network.IPAM.Config && network.IPAM.Config[0]) || {};
    setSubnet(cfg.Subnet || cfg.subnet || '');
    setGateway(cfg.Gateway || cfg.gateway || '');
  }, [network]);

  if (!network) return null;

  const builtin = ['bridge','host','none'].includes(network.Name);

  async function save(){
    if (builtin) {
      showNotification && showNotification('Builtin networks cannot be edited', 'error');
      return;
    }
    try {
      setSaving(true);
      // send update request to backend; backend may implement recreate or validation
      await axios.post('/api/networks/update', { name: network.Name, ipam: { Subnet: subnet || undefined, Gateway: gateway || undefined } });
      showNotification && showNotification('Network updated', 'info');
      onSave && onSave();
      onClose && onClose();
    } catch (e) {
      showNotification && showNotification('Update failed: '+((e.response && e.response.data && e.response.data.error) || e.message),'error');
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold">Edit Network: {network.Name}</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="mb-4">
          <div className="text-sm text-gray-700 mb-2">Driver: <strong>{network.Driver || 'unknown'}</strong></div>
          {builtin && <div className="text-sm text-red-600 mb-2">This is a builtin network and cannot be edited.</div>}
          <label className="block text-sm font-medium mb-1">Subnet</label>
          <input className="border rounded px-3 py-2 w-full mb-2" value={subnet} onChange={e=>setSubnet(e.target.value)} placeholder="e.g. 172.18.0.0/16" />
          <label className="block text-sm font-medium mb-1">Gateway</label>
          <input className="border rounded px-3 py-2 w-full mb-2" value={gateway} onChange={e=>setGateway(e.target.value)} placeholder="e.g. 172.18.0.1" />
        </div>
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
          <button className={`px-3 py-1 rounded ${saving ? 'bg-gray-400' : 'bg-yellow-600 text-white'}`} onClick={save} disabled={saving || builtin}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function DeleteNetworkModal({network, onClose, onDelete}){
  const [confirmName, setConfirmName] = useState('');
  const networkName = network.Name;
  const error = confirmName !== networkName ? 'Name does not match' : '';

  function handleDelete() {
    if (error) return;
    onDelete(networkName);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded w-1/2 p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg font-semibold text-red-600">Delete Network</div>
          <button className="text-sm text-gray-600" onClick={onClose}>Close</button>
        </div>
        <div className="mb-4">
          <div className="text-sm text-gray-700 mb-2">
            Are you sure you want to delete the network <strong>{networkName}</strong>?
          </div>
          <div className="text-sm text-red-600 mb-4">
            This action cannot be undone. The network will be permanently deleted.
          </div>
          <label className="block text-sm font-medium mb-2">
            Type <strong>{networkName}</strong> to confirm:
          </label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full"
            value={confirmName}
            onChange={e => setConfirmName(e.target.value)}
            placeholder={`Type ${networkName} to confirm`}
          />
          {error && <div className="text-sm text-red-600 mt-1">{error}</div>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-1 bg-gray-200 rounded" onClick={onClose}>Cancel</button>
          <button
            className={`px-3 py-1 rounded ${error ? 'bg-gray-400 cursor-not-allowed' : 'bg-red-600 text-white'}`}
            onClick={handleDelete}
            disabled={!!error}
          >
            Delete Network
          </button>
        </div>
      </div>
    </div>
  );
}
