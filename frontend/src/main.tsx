import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './theme.css'
import './app.css'
import Home from './pages/Home'
import Build from './pages/Build'
import Workspace from './pages/Workspace'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/build/:jobId" element={<Build />} />
        <Route path="/r/:repoId" element={<Workspace />} />
        <Route path="/r/:repoId/:tab" element={<Workspace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
