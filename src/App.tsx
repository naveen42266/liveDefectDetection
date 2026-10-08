import './App.css'
import { Routes, Route, BrowserRouter } from 'react-router-dom';


const Home = () => {
  return (
    <div className='text-secondary'>Home</div>
  )
}



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