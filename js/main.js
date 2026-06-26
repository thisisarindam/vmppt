// ── PDF.js worker setup ──
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let selectedFiles = [];

// ── DOM ELEMENTS & EVENT LISTENERS ──
document.addEventListener('DOMContentLoaded', () => {
  const filePicker = document.getElementById('filePicker');
  const browseBtn = document.getElementById('browseBtn');
  const scanBtn = document.getElementById('scanBtn');
  const zone = document.getElementById('uploadZone');

  // Wire up buttons
  browseBtn.addEventListener('click', openFilePicker);
  scanBtn.addEventListener('click', startScan);

  // File Picker Setup
  filePicker.accept = '.pptx,.ppt,.pdf,.jpg,.jpeg,.png';
  filePicker.addEventListener('change', (e) => processFiles(Array.from(e.target.files)));

  // Drag and Drop
  zone.addEventListener('dragover', ev => { 
    ev.preventDefault(); 
    zone.classList.add('drag'); 
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', ev => {
    ev.preventDefault(); 
    zone.classList.remove('drag');
    if (ev.dataTransfer.files.length) processFiles(Array.from(ev.dataTransfer.files));
  });
});

// ── FILE UI LOGIC ──
function openFilePicker() {
  document.getElementById('filePicker').click();
}

function processFiles(files) {
  showError('');
  const allowed = files.filter(f => /\.(pptx?|pdf|jpe?g|png|webp)$/i.test(f.name));
  if (!allowed.length) return showError('No supported files found.');
  selectedFiles = allowed;
  
  const zone = document.getElementById('uploadZone');
  zone.classList.add('has-files');
  document.getElementById('uploadTitle').textContent = 'Files ready:';
  document.getElementById('fileList').innerHTML = selectedFiles.map(f => `<span class="file-pill">${f.name}</span>`).join('');
  document.getElementById('scanBtn').disabled = false;
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  if (msg) { 
    box.innerHTML = '⚠️ ' + msg; 
    box.classList.add('show'); 
  } else { 
    box.innerHTML = ''; 
    box.classList.remove('show'); 
  }
}

// ── EXTRACT FROM PPTX ──
async function extractFromPPTX(file) {
  const ab = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(ab);
  const images = [];
  const slideRels = Object.keys(zip.files)
    .filter(k => /ppt\/slides\/_rels\/slide\d+\.xml\.rels/.test(k));

  if (!slideRels.length) {
    const mediaFiles = Object.keys(zip.files).filter(k => /ppt\/media\/.+\.(png|jpe?g)/i.test(k));
    for (let i=0; i<mediaFiles.length; i++) {
      const b64 = await zip.files[mediaFiles[i]].async('base64');
      images.push({ slide: i+1, src: `data:image/jpeg;base64,${b64}` });
    }
    return images;
  }

  for (let i=0; i<slideRels.length; i++) {
    const relContent = await zip.files[slideRels[i]].async('text');
    const imgRefs = [...relContent.matchAll(/Target="(?:\.\.\/)?media\/([^"]+)"/g)].map(m => m[1]);
    for (const imgName of imgRefs) {
      const imgPath = `ppt/media/${imgName}`;
      if (zip.files[imgPath]) {
        const b64 = await zip.files[imgPath].async('base64');
        images.push({ slide: i+1, src: `data:image/jpeg;base64,${b64}` });
        break; 
      }
    }
  }
  return images;
}

// ── EXTRACT FROM PDF ──
async function extractFromPDF(file) {
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const images = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    images.push({ slide: i, src: canvas.toDataURL('image/jpeg', 0.85) });
  }
  return images;
}

// ── COMPRESS IMAGES ──
function resizeImage(dataUrl, maxW = 1024) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.src = dataUrl;
  });
}

// ── MAIN FLOW ──
async function startScan() {
  const storeName = document.getElementById('storeName').value.trim() || 'Unknown Store';
  const pazoNo = document.getElementById('pazoNo').value.trim();
  const btn = document.getElementById('scanBtn');
  const prog = document.getElementById('progressWrap');
  
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div>&nbsp; Processing...';
  prog.classList.add('show');
  
  const setProg = (msg, pct) => { 
    document.getElementById('progressLabel').textContent = msg; 
    document.getElementById('progressFill').style.width = pct + '%'; 
  };

  try {
    setProg('Extracting images...', 10);
    let allImages = [];
    
    // 1. Extract Images Locally
    for (let i = 0; i < selectedFiles.length; i++) {
      const f = selectedFiles[i];
      if (/\.pptx?$/i.test(f.name)) allImages.push(...await extractFromPPTX(f));
      else if (/\.pdf$/i.test(f.name)) allImages.push(...await extractFromPDF(f));
      else {
        const src = await new Promise(res => {
          const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(f);
        });
        allImages.push({ slide: i+1, src });
      }
    }

    // 2. Compress payload
    setProg('Compressing data...', 40);
    const payloadImages = [];
    for (let img of allImages) {
      const resized = await resizeImage(img.src);
      // Strip the base64 header to save space
      payloadImages.push({ slide: img.slide, b64: resized.split(',')[1] }); 
    }

    // 3. Send securely to YOUR backend
    setProg('Uploading to secure server...', 70);
    document.getElementById('progressSub').textContent = 'Waiting for queue processing...';

    const payload = { storeName, pazoNo, images: payloadImages };
    
    /* =========================================
      IMPORTANT: POINT THIS TO YOUR RENDER APP
      =========================================
    */
    const response = await fetch('https://vmppt.onrender.com/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error('Server error during processing.');
    
    const resultData = await response.json();
    
    setProg('Complete!', 100);
    
// 4. Render the returned JSON to the screen
    const reportDiv = document.getElementById('summaryText'); // Assuming this is your container
    
    // Build the Executive Summary
    let htmlContent = `
        <div style="background: #2a2a2a; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="color: #ff8c00; margin-top: 0;">AI Executive Summary</h3>
            <p style="color: #ffffff; line-height: 1.6;">${resultData.summary}</p>
        </div>
        <h3 style="color: #ff8c00;">Detailed Parameter Breakdown</h3>
    `;

    // Loop through every VM category (facade, layout, etc.)
    resultData.categories.forEach(category => {
        htmlContent += `<div style="background: #1e1e1e; padding: 15px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #4CAF50;">`;
        htmlContent += `<h4 style="color: #ffffff; text-transform: uppercase; margin-top: 0;">${category.id}</h4>`;
        
        category.params.forEach(param => {
            let statusColor = '#888'; // Default gray for NA
            if (param.status === 'PASS') statusColor = '#4CAF50'; // Green
            if (param.status === 'FAIL') statusColor = '#F44336'; // Red
            
            htmlContent += `
                <p style="color: #ccc; margin-bottom: 5px;">
                    <span style="background: ${statusColor}; color: white; padding: 3px 8px; border-radius: 3px; font-weight: bold; margin-right: 10px;">${param.status}</span>
                    ${param.note}
                </p>
            `;
        });
        htmlContent += `</div>`;
    });

    // Inject the painted HTML
    reportDiv.innerHTML = htmlContent;