import './App.css'
import { Routes, Route, BrowserRouter } from 'react-router-dom';
import Home from './pages';


function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Teacher Pages */}
        <Route index element={<Home />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App