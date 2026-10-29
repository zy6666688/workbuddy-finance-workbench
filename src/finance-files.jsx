import React, { useEffect, useMemo, useRef, useState } from 'react'
import { defaultPinnedPaths, fileKind, filterFiles, orderFiles, summarizeFiles, topFolder } from './ui-helpers.js'

const types = { all: '全部类型', document: '文档', sheet: '表格', slides: '演示', image: '图片', other: '其他' }
const size = bytes => Number(bytes) >= 1048576 ? `${(Number(bytes) / 1048576).toFixed(1)} MB` : `${Math.ceil(Number(bytes) / 1024)} KB`

// The standalone plugin keeps its local array; the team host supplies a paged
// data source. Never treat a server page as the entire collection.
export function FileLibrary({ files, workspace, remote, onOpenWorkspace, onChooseFiles, onChooseFolder, onUploadFiles, onReferenceFile, onDownloadFile, onStatus, onAudit, pinnedFiles: pinned, setPinnedFiles: setPinned }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [folder, setFolder] = useState('all'), [order, setOrder] = useState('recent')
  const [offset, setOffset] = useState(0), [dragging, setDragging] = useState(false), [data, setData] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const pageVersion = useRef(''), request = useRef(0), remoteRef = useRef(remote)
  remoteRef.current = remote
  const pinKey = JSON.stringify(pinned), filterKey = JSON.stringify([query,kind,folder,order,pinKey,remote?.scopeKey,remote?.refreshKey])
  const local = useMemo(() => orderFiles(filterFiles(files, query, kind, folder), pinned, order), [files,query,kind,folder,pinKey,order])
  useEffect(() => { if (!remote && files.length && !pinned.length) { const defaults = defaultPinnedPaths(files); if (defaults.length) setPinned(defaults) } }, [files.length, !!remote])
  useEffect(() => { pageVersion.current = ''; setOffset(0) }, [filterKey])
  useEffect(() => {
    if (!remote) return
    const n = ++request.current
    setLoading(true); setError('')
    // Reset effects run before this effect; don't issue an old offset with a
    // newly cleared snapshot, then let the zero-offset render load the page.
    if (offset && !pageVersion.current) { setOffset(0); return }
    remoteRef.current.load({search:query,fileType:kind,category:folder==='all'?'':folder,sort:order,offset,limit:50,...(offset ? {pageVersion:pageVersion.current} : {})}).then(result => {
      if (n !== request.current) return
      if (offset && !result.rows.length && result.filteredTotal) { pageVersion.current=''; setOffset(0); return }
      pageVersion.current=result.pageVersion; setData(result); setLoading(false)
    }).catch(e => {
      if (n !== request.current) return
      setLoading(false)
      if (e.status === 409 && offset) { pageVersion.current=''; setOffset(0); onStatus('资料或置顶顺序已变化，已回到第一页；已选引用保留。') }
      else setError(e.message || '资料读取失败，请重试')
    })
    return () => { request.current++ }
  }, [filterKey,offset,retry,!!remote])
  useEffect(() => { if (!remote && offset >= local.length && offset) setOffset(Math.max(0,Math.floor(Math.max(0,local.length-1)/50)*50)) }, [local.length,offset,!!remote])
  const summary = remote ? (data?.scopeSummary || remote.summary || {total:0,bytes:0}) : summarizeFiles(files)
  const folders = remote ? (data?.facets?.categories || []) : [...new Set(files.map(f=>topFolder(f.relative)))].sort((a,b)=>a.localeCompare(b,'zh-CN'))
  const rows = remote ? (data?.rows || []) : local.slice(offset,offset+50), total = remote ? (data?.filteredTotal || 0) : local.length
  const isPinned = f => pinned.includes(f.relative) || pinned.includes(f.id)
  const pageCount = Math.max(1, Math.ceil(total / 50))
  const pagination = position => <nav className="fdDesk_filePager" aria-label={`资料${position}分页`}>
    <button type="button" disabled={loading || !offset} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</button>
    <form key={`${position}-${offset}-${total}`} onSubmit={e=>{e.preventDefault(); const value=Number(new FormData(e.currentTarget).get('page')); if(Number.isInteger(value)&&value>=1&&value<=pageCount)setOffset((value-1)*50)}}>
      <label>第 <input aria-label={`${position}页码`} name="page" type="number" min="1" max={pageCount} defaultValue={Math.floor(offset/50)+1} disabled={loading}/> / {pageCount} 页</label><button disabled={loading} type="submit">跳转</button>
    </form>
    <button type="button" disabled={loading || offset+50>=total} onClick={()=>setOffset(offset+50)}>下一页</button>
  </nav>
  const togglePin = f => {
    const pinning = !isPinned(f)
    setPinned(current => pinning ? [...current, f.relative] : current.filter(x=>x!==f.relative && x!==f.id))
    onAudit('资料库', pinning ? '置顶文件' : '取消置顶', f.relative); onStatus('资料库置顶已更新')
  }
  return <div className="fdDesk_page">
    <div className="fdDesk_directory"><span>库</span><div><small>当前财务资料{remote ? '范围' : '目录'}</small><strong>{workspace.name}</strong><em title={workspace.path}>{workspace.path || '等待工作区准备'}</em></div><button type="button" onClick={onOpenWorkspace}>{remote ? '打开月度工作单' : workspace.mode==='index' ? '文件索引说明' : '打开资料目录'}</button></div>
    <div className={`fdDesk_dropzone ${dragging?'is-dragging':''}`} onDragEnter={e=>{e.preventDefault();setDragging(true)}} onDragOver={e=>{e.preventDefault();setDragging(true)}} onDragLeave={e=>{if(e.currentTarget===e.target)setDragging(false)}} onDrop={e=>{e.preventDefault();setDragging(false);onUploadFiles([...e.dataTransfer.files])}}><span>＋</span><div><strong>{workspace.mode==='index'?'选择并索引财务资料':'上传并存档财务资料'}</strong><small>支持文件、文件夹和拖放；原始文件不会被覆盖。{remote?' 文件按业务类别管理。':''}</small></div><button type="button" onClick={onChooseFiles}>选择文件</button><button type="button" onClick={onChooseFolder}>选择文件夹</button></div>
    <div className="fdDesk_fileStats">{[['文件',summary.total],['表格',summary.sheet],['文档',summary.document],['图片',summary.image],['总大小',size(summary.bytes||0)]].map(([label,value])=><div key={label}><strong>{value||0}</strong><span>{remote?'本期全部':''}{label}</span></div>)}</div>
    {remote?.selection}
    <div className="fdDesk_fileFilters"><input aria-label="搜索资料库" value={query} maxLength={100} onChange={e=>setQuery(e.target.value)} placeholder={remote?'搜索文件名或类别':'搜索文件名或目录'}/><select aria-label="文件类型" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(types).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><select aria-label={remote?'文件类别':'文件目录'} value={folder} onChange={e=>setFolder(e.target.value)}><option value="all">{remote?'全部类别':'全部目录'}</option>{folders.map(x=><option key={x} value={x}>{x}</option>)}</select><select aria-label="文件排序" value={order} onChange={e=>setOrder(e.target.value)}><option value="recent">最近更新</option><option value="name">按名称</option><option value="size">按大小</option></select></div>
    <div className="fdDesk_fileHeading fdDesk_filePageToolbar"><span role="status">{loading?'正在读取…':`${total} 个结果 · ${total?offset+1:0}–${Math.min(offset+rows.length,total)}`} · 置顶优先</span>{pagination('上方')}</div>
    {error?<div role="alert" className="fdDesk_empty">{error} <button type="button" onClick={()=>setRetry(x=>x+1)}>重试</button></div>:<div className="fdDesk_fileList" aria-busy={loading}>{rows.map(file=><article key={file.id||file.relative} className={isPinned(file)?'is-pinned':''}><button type="button" className="fdDesk_pin" disabled={loading} aria-label={`${isPinned(file)?'取消置顶':'置顶'}${file.name}`} onClick={()=>togglePin(file)}>{isPinned(file)?'★':'☆'}</button><span className={`is-${fileKind(file.relative)}`}>{fileKind(file.relative).slice(0,1).toUpperCase()}</span><div title={file.relative}><strong>{file.name}</strong><small>{remote?`${file.category} · v${file.version}`:file.relative} · {size(file.size)} · {new Date(file.modifiedAt).toLocaleDateString('zh-CN')}</small></div><button type="button" disabled={loading || (remote && !file.canReference)} onClick={()=>onReferenceFile(file)}>引用</button><button type="button" disabled={loading || (remote && !file.canDownload)} onClick={()=>onDownloadFile(file)}>下载</button></article>)}{!rows.length&&!loading&&<div className="fdDesk_empty">没有符合条件的文件</div>}</div>}
    <div className="fdDesk_fileHeading fdDesk_filePageToolbar"><span>每页 50 条</span>{pagination('下方')}</div>
  </div>
}
