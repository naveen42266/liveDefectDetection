import './App.css'
import { Routes, Route, BrowserRouter } from 'react-router-dom';
import Home from './pages';
import TyreDepth from './pages/treadDepth';


function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Teacher Pages */}
        <Route index element={<Home />} />
        <Route path='/TreadDepth' element={<TyreDepth onCapture={() => { }} />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App